"""The app build engine: the owner asks for a web application and the engineering
team builds it, each engineer the files of their own role.

  owner's request → the architect's design (JSON, validated) → OWNER APPROVAL
    → engineers write the files, one model call per file (backend, frontend, setup, docs)
    → automatic syntax checks (no model) → review → authors fix their files, once
    → the CTO's delivery note → ready (stored; can be downloaded, run and changed)

A change request repeats the same path for the files it touches and produces a new
version; the other files are carried over.

Guarantees, enforced here rather than in prompts:
  * Who writes what is decided by role, in code (`roles.py`); models never pick people.
  * Nothing is written before the owner approves the design.
  * Bounded work: at most MAX_FILES files, MAX_ATTEMPTS attempts per step, MAX_REVISIONS
    fix round per file, a per-version cap on model requests and a run-time limit.
  * Every step is persisted before the next one starts, so a pause, a failure or a
    restart loses nothing that was written; nothing resumes on its own.
  * Problems that remain after the fix round are recorded on the files, never hidden.
"""

from __future__ import annotations

import asyncio
import math
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.gateway import AIGateway, GatewayError
from app.apps import checks, plans, prompts, roles
from app.apps.errors import AppError
from app.apps.prompts import FileInfo
from app.apps.stacks import STACKS, WRITE_ORDER, Stack, area_of, tree_sha256
from app.core.events import EventBus
from app.core.logging import get_logger
from app.db.session import Database
from app.models import (
    APP_ACTIVE,
    APP_FINISHED,
    App,
    AppEvent,
    AppFile,
    AppStatus,
    AppVersion,
    Conversation,
    Employee,
    EmployeeStatus,
    FileStatus,
    Message,
    MessageRole,
    MessageStatus,
)
from app.orchestration.engine import PAUSE_KINDS, RETRY_KINDS, new_id, now, title_for
from app.orchestration.plans import PlanError
from app.orchestration.prompts import clean_text
from app.services.activity import ActivityTracker, Screen

if TYPE_CHECKING:
    from app.storage.artifacts import ArtifactRegistrar

log = get_logger("nexus.apps")

DEFAULT_MAX_CALLS = 45
MAX_ATTEMPTS = 2
MAX_REVISIONS = 1
MAX_RUN_SECONDS = 45 * 60
MAX_TOKENS = {"plan": 4000, "file": 8000, "review": 2500, "delivery": 1200}
RESTARTED = "The server restarted while this app was being built. Press Resume to continue."


class _Pause(Exception):
    pass


class _LimitReached(Exception):
    pass


class _StepFailed(Exception):
    pass


@dataclass(frozen=True)
class _Build:
    """The version a driver is working on."""

    app_id: str
    version_id: str
    number: int


def _feedback(error: str | None, what: str = "valid JSON only") -> str:
    if not error:
        return ""
    return f"\n\nYour previous reply could not be used: {error} Reply again with {what}."


# ===================================================================== queries


async def latest_version(
    session: AsyncSession, app_id: str, number: int | None = None
) -> AppVersion | None:
    # Always the stored state, even if this session saw the row before a driver changed it.
    query = (
        select(AppVersion)
        .where(AppVersion.app_id == app_id)
        .execution_options(populate_existing=True)
    )
    if number is None:
        query = query.order_by(AppVersion.number.desc()).limit(1)
    else:
        query = query.where(AppVersion.number == number)
    return await session.scalar(query)


async def version_files(session: AsyncSession, version_id: str) -> list[AppFile]:
    return list(
        await session.scalars(
            select(AppFile)
            .where(AppFile.version_id == version_id)
            .order_by(AppFile.position, AppFile.id)
            .execution_options(populate_existing=True)
        )
    )


def written_tree(files: list[AppFile]) -> dict[str, str]:
    return {f.path: f.content for f in files if f.status == FileStatus.WRITTEN}


def known_issues(files: list[AppFile]) -> list[str]:
    """What is still wrong after the checks, the review and the fix round."""
    issues = []
    for f in files:
        if f.status == FileStatus.FAILED:
            issues.append(f"{f.path}: could not be written — {f.error or 'unknown error'}")
        elif f.check == checks.FAILED:
            issues.append(f"{f.path}: {f.check_error or 'failed its syntax check'}")
    return issues


class AppBuilder:
    def __init__(
        self,
        database: Database,
        gateway: AIGateway,
        events: EventBus,
        activity: ActivityTracker,
        chat: Any,
        scratch: Path,
        artifacts: ArtifactRegistrar | None = None,
    ) -> None:
        self.database = database
        self.gateway = gateway
        self.events = events
        self.activity = activity
        self.chat = chat
        self.scratch = scratch  # where files are written for the sandbox to check
        self.artifacts = artifacts
        self.check = checks.check  # replaced in tests that don't have a sandbox
        self.running: dict[str, asyncio.Task[None]] = {}
        self._restart_pending: set[str] = set()
        self._closing = False
        self._deadline: dict[str, float] = {}
        self._calls = asyncio.Lock()

    # =============================================================== owner API

    async def create(
        self,
        session: AsyncSession,
        description: str,
        *,
        conversation_id: str | None = None,
        max_calls: int = DEFAULT_MAX_CALLS,
    ) -> App:
        team = await self._team(session)
        architect = team.architect
        app = App(
            id=new_id("app"),
            name=title_for(description)[:120],
            description=description.strip(),
            current_version=1,
            source_conversation_id=conversation_id,
        )
        session.add(app)
        session.add(self._new_version(app.id, 1, app.description, architect, max_calls))
        await self._commit_with(
            session,
            app,
            1,
            "created",
            f"The owner asked engineering for an app: “{app.name}”.",
            actor=architect,
            messages=[
                self._notice(
                    app,
                    f"App requested: {architect.name} is designing “{app.name}”. "
                    "Nothing is written until you approve the design.",
                )
            ],
        )
        await session.refresh(app)
        await self._publish(app.id)
        self.start(app.id)
        return app

    async def request_change(
        self,
        session: AsyncSession,
        app_id: str,
        request: str,
        max_calls: int = DEFAULT_MAX_CALLS,
    ) -> App:
        app = await self._get(session, app_id)
        latest = await latest_version(session, app_id)
        if latest is not None and latest.status not in APP_FINISHED:
            raise AppError("Finish or cancel the current build before asking for a change.")
        base = await session.scalar(
            select(AppVersion)
            .where(AppVersion.app_id == app_id, AppVersion.status == AppStatus.READY.value)
            .order_by(AppVersion.number.desc())
            .limit(1)
        )
        if base is None:
            raise AppError("This app has no finished version to change yet. Start a new app.")
        team = await self._team(session)
        number = app.current_version + 1
        version = self._new_version(app.id, number, request.strip(), team.architect, max_calls)
        version.base_version = base.number
        version.stack = base.stack
        session.add(version)
        app.current_version = number
        await self._commit_with(
            session,
            app,
            number,
            "change_requested",
            f"The owner asked for a change: “{title_for(request)}”.",
            actor=team.architect,
            messages=[
                self._notice(
                    app,
                    f"Change requested for “{app.name}”: {team.architect.name} is planning it. "
                    "Nothing is rewritten until you approve the plan.",
                )
            ],
        )
        await session.refresh(app)
        await self._publish(app_id)
        self.start(app_id)
        return app

    async def approve(self, session: AsyncSession, app_id: str) -> None:
        """Owner checkpoint: only an approved design is ever built."""
        await self._get(session, app_id)
        version = await latest_version(session, app_id)
        if version is None:
            raise AppError("App not found.", 404)
        result = await session.execute(
            update(AppVersion)
            .where(
                AppVersion.id == version.id,
                AppVersion.status == AppStatus.AWAITING_APPROVAL.value,
            )
            .values(status=AppStatus.BUILDING.value, approved_at=now(), status_reason=None)
            .execution_options(synchronize_session=False)
        )
        if result.rowcount != 1:  # type: ignore[attr-defined]
            raise AppError("Only a design that is waiting for your approval can be approved.")
        await session.commit()
        files = await version_files(session, version.id)
        planned = sum(f.status == FileStatus.PLANNED for f in files)
        await self._event(
            _Build(app_id, version.id, version.number),
            "approved",
            f"The owner approved the design ({planned} file{'s' if planned != 1 else ''} to write).",
        )
        await self._publish(app_id)
        self.start(app_id)

    async def cancel(self, app_id: str, reason: str = "Cancelled by the owner.") -> None:
        async with self.database.sessionmaker() as session:
            await self._get(session, app_id)
            version = await latest_version(session, app_id)
            if version is None or version.status in APP_FINISHED:
                raise AppError("There is no build in progress to cancel.")
        await self._halt(app_id)  # stop in-flight work before recording the cancellation
        async with self.database.sessionmaker() as session:
            app = await self._get(session, app_id)
            version = await latest_version(session, app_id)
            if version is None or version.status in APP_FINISHED:
                raise AppError("There is no build in progress to cancel.")
            version.status = AppStatus.CANCELLED.value
            version.status_reason = reason
            version.finished_at = now()
            await self._settle_files(session, version.id)
            await self._commit_with(
                session,
                app,
                version.number,
                "cancelled",
                reason,
                messages=[self._notice(app, f"App build cancelled: {reason}")],
            )
        await self._publish(app_id)

    async def resume(self, app_id: str) -> None:
        async with self.database.sessionmaker() as session:
            await self._get(session, app_id)
            version = await latest_version(session, app_id)
            if version is None or version.status not in (AppStatus.PAUSED, AppStatus.FAILED):
                raise AppError("Only a paused or failed build can be resumed.")
            if version.calls_used >= version.max_calls:
                raise AppError(
                    "This version used all of its model requests. Ask for the change again, "
                    "or start a new app."
                )
            if version.plan is None:
                version.status = AppStatus.PLANNING.value
                version.plan_attempts = 0
            elif version.approved_at is None:
                version.status = AppStatus.AWAITING_APPROVAL.value
            else:
                version.status = AppStatus.BUILDING.value
                for file in await version_files(session, version.id):
                    if file.status == FileStatus.FAILED:
                        file.status = FileStatus.PLANNED.value
                        file.attempts = 0
                        file.error = None
            version.status_reason = None
            version.finished_at = None
            build = _Build(app_id, version.id, version.number)
            await session.commit()
        await self._event(build, "resumed", "The owner resumed the build.")
        await self._publish(app_id)
        self.start(app_id)

    async def delete(self, session: AsyncSession, app_id: str) -> None:
        """Removes the app with every version (the owner's explicit choice)."""
        app = await self._get(session, app_id)
        await self._halt(app_id)
        await session.delete(app)
        await session.commit()
        self.events.publish("app.deleted", {"id": app_id})
        log.info("apps.deleted", app_id=app_id)

    async def recover(self) -> None:
        """After a restart nothing is running: active builds pause, files that were
        being written go back to waiting, and the owner decides when to resume."""
        paused: list[_Build] = []
        async with self.database.sessionmaker() as session:
            versions = list(
                await session.scalars(
                    select(AppVersion).where(AppVersion.status.in_([s.value for s in APP_ACTIVE]))
                )
            )
            for version in versions:
                version.status = AppStatus.PAUSED.value
                version.status_reason = RESTARTED
                await self._settle_files(session, version.id)
                paused.append(_Build(version.app_id, version.id, version.number))
            await session.commit()
        for build in paused:
            await self._event(build, "paused", RESTARTED)
        if paused:
            log.warning("apps.recovered", paused=len(paused))

    async def shutdown(self) -> None:
        self._closing = True
        for app_id in list(self.running):
            await self._halt(app_id)

    # ================================================================== driver

    def start(self, app_id: str) -> None:
        if self._closing:
            return
        task = self.running.get(app_id)
        if task is not None and not task.done():
            if app_id not in self._restart_pending:
                self._restart_pending.add(app_id)

                def restart(_finished: asyncio.Task[None]) -> None:
                    self._restart_pending.discard(app_id)
                    self.start(app_id)

                task.add_done_callback(restart)
            return
        self.running[app_id] = asyncio.create_task(self._drive(app_id), name=f"app-{app_id}")

    async def _halt(self, app_id: str) -> None:
        """Stops the driver and waits until it has let go, so nothing it was doing can
        overwrite what happens next."""
        task = self.running.get(app_id)
        if task is None or task.done() or task is asyncio.current_task():
            return
        task.cancel()
        await asyncio.wait([task], timeout=10)

    async def _drive(self, app_id: str) -> None:
        build: _Build | None = None
        limit = DEFAULT_MAX_CALLS
        try:
            async with self.database.sessionmaker() as session:
                version = await latest_version(session, app_id)
                if version is None or version.status not in APP_ACTIVE:
                    return
                build = _Build(app_id, version.id, version.number)
                planning = version.status == AppStatus.PLANNING
                limit = version.max_calls
            self._deadline[build.version_id] = time.monotonic() + MAX_RUN_SECONDS
            if planning:
                await self._plan(build)
            else:
                await self._build(build)
        except _Pause as pause:
            if build:
                await self._pause(build, str(pause))
        except _LimitReached:
            if build:
                await self._fail(
                    build,
                    f"Stopped at the safety limit of {limit} model requests for one version.",
                )
        except _StepFailed as failed:
            if build:
                await self._fail(build, str(failed))
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("apps.driver_crashed", app_id=app_id)
            if build:
                await self._fail(build, "Internal error in the app builder (see the server log).")
        finally:
            if build:
                self._deadline.pop(build.version_id, None)
            if self.running.get(app_id) is asyncio.current_task():
                self.running.pop(app_id, None)

    async def _build(self, build: _Build) -> None:
        await self._status(build, AppStatus.BUILDING)
        while True:
            async with self.database.sessionmaker() as session:
                file_id = await session.scalar(
                    select(AppFile.id)
                    .where(
                        AppFile.version_id == build.version_id,
                        AppFile.status == FileStatus.PLANNED.value,
                    )
                    .order_by(AppFile.position, AppFile.id)
                    .limit(1)
                )
            if file_id is None:
                break
            await self._write(build, file_id)

        await self._status(build, AppStatus.CHECKING)
        await self._check(build)

        async with self.database.sessionmaker() as session:
            version = await session.get(AppVersion, build.version_id)
            assert version is not None
            reviewed, fixed, delivered = version.reviewed_at, version.fixed_at, version.summary
        if reviewed is None:
            await self._status(build, AppStatus.REVIEWING)
            await self._review(build)
        if fixed is None:
            await self._status(build, AppStatus.FIXING)
            await self._fix(build)
        if delivered is None:
            await self._status(build, AppStatus.DELIVERING)
            await self._deliver(build)
        await self._ready(build)

    # =================================================================== steps

    async def _plan(self, build: _Build) -> None:
        async with self.database.sessionmaker() as session:
            version = await session.get(AppVersion, build.version_id)
            app = await session.get(App, build.app_id)
            assert version is not None and app is not None
            team = await self._team(session, failing=True)
            architect = await session.get(Employee, version.architect_id or "")
            if architect is None or architect.status == EmployeeStatus.SUSPENDED:
                architect = team.architect
                version.architect_id = architect.id
                await session.commit()
            request, base, name = version.request, version.base_version, app.name
        if base is None:
            await self._design(build, architect, request, name)
        else:
            await self._plan_change(build, architect, request, base, name)

    async def _design(self, build: _Build, architect: Employee, request: str, title: str) -> None:
        base = prompts.design_prompt(request)

        async def attempt(feedback: str | None) -> plans.Design:
            text, _ = await self._ask(
                build,
                architect,
                "app_plan",
                base + _feedback(feedback),
                EmployeeStatus.WORKING.value,
                f"Designing the app: {title}",
                MAX_TOKENS["plan"],
                Screen("plan", f"App design: {title}", brief=request),
            )
            return plans.parse_design(text)

        design = await self._attempts(build, "Design", attempt)
        stack = STACKS[design.stack]
        async with self.database.sessionmaker() as session:
            version = await session.get(AppVersion, build.version_id)
            app = await session.get(App, build.app_id)
            if version is None or app is None or version.status != AppStatus.PLANNING:
                return
            team = await self._team(session, failing=True)
            app.name = design.name.strip()[:120]
            version.stack = stack.key
            version.plan = {
                "name": app.name,
                "summary": design.summary,
                "stack": stack.key,
                "api": design.api,
                "packages": design.packages,
                "files": [{"path": f.path, "purpose": f.purpose} for f in design.files],
            }
            rows = [
                self._file_row(
                    version.id, stack, f.path, f.purpose, team.author(area_of(stack, f.path))
                )
                for f in self._ordered(stack, [(f.path, f) for f in design.files])
            ]
            for position, row in enumerate(rows):
                row.position = position
                session.add(row)
            version.status = AppStatus.AWAITING_APPROVAL.value
            await self._commit_with(
                session,
                app,
                version.number,
                "designed",
                f"{architect.name} designed “{app.name}”: {len(rows)} files, {stack.name}. "
                "Waiting for the owner's approval.",
                actor=architect,
                messages=[
                    self._notice(
                        app,
                        f"The design of “{app.name}” is ready ({len(rows)} files). "
                        "Review who writes what and approve it to start the build.",
                    )
                ],
            )
        await self._publish(build.app_id)

    async def _plan_change(
        self, build: _Build, architect: Employee, request: str, base_number: int, name: str
    ) -> None:
        async with self.database.sessionmaker() as session:
            base = await latest_version(session, build.app_id, base_number)
            if base is None or base.stack not in STACKS:
                raise _StepFailed("The version this change builds on no longer exists.")
            stack = STACKS[base.stack]
            base_plan = dict(base.plan or {})
            base_files = await version_files(session, base.id)
            infos = [self._info(f) for f in base_files]
        existing = {f.path for f in base_files}
        prompt = prompts.change_prompt(
            request=request,
            name=name,
            summary=str(base_plan.get("summary", "")),
            stack=stack,
            api=str(base_plan.get("api", "")),
            files=infos,
        )

        async def attempt(feedback: str | None) -> plans.Change:
            text, _ = await self._ask(
                build,
                architect,
                "app_change",
                prompt + _feedback(feedback),
                EmployeeStatus.WORKING.value,
                f"Planning a change to {name}",
                MAX_TOKENS["plan"],
                Screen("plan", f"Change to {name}", brief=request),
            )
            return plans.parse_change(text, stack, existing)

        change = await self._attempts(build, "Change plan", attempt)
        by_path = {c.path: c for c in change.files}
        async with self.database.sessionmaker() as session:
            version = await session.get(AppVersion, build.version_id)
            app = await session.get(App, build.app_id)
            if version is None or app is None or version.status != AppStatus.PLANNING:
                return
            team = await self._team(session, failing=True)
            available = {m.id: m for m in team.members}
            rows: list[AppFile] = []
            for old in base_files:
                planned = by_path.get(old.path)
                if planned is not None and planned.action == "delete":
                    continue
                row = AppFile(
                    version_id=version.id,
                    path=old.path,
                    area=old.area,
                    purpose=old.purpose,
                    action="keep",
                    employee_id=old.employee_id,
                    author_name=old.author_name,
                    author_role=old.author_role,
                    status=FileStatus.WRITTEN.value,
                    content=old.content,
                    check=old.check,
                    check_error=old.check_error,
                )
                if planned is not None:  # modify: the same engineer when still available
                    author = available.get(old.employee_id or "") or team.author(old.area)
                    row.action = "modify"
                    row.status = FileStatus.PLANNED.value
                    row.instructions = planned.instructions.strip()
                    row.check = row.check_error = None
                    self._assign(row, author)
                rows.append(row)
            for planned in change.files:
                if planned.action == "add":
                    row = self._file_row(
                        version.id,
                        stack,
                        planned.path,
                        planned.purpose,
                        team.author(area_of(stack, planned.path)),
                    )
                    row.instructions = planned.instructions.strip()
                    rows.append(row)
            rows = self._ordered(stack, [(r.path, r) for r in rows])
            for position, row in enumerate(rows):
                row.position = position
                session.add(row)
            packages = list(dict.fromkeys([*base_plan.get("packages", []), *change.packages]))
            version.stack = stack.key
            version.plan = {
                "name": app.name,
                "summary": base_plan.get("summary", ""),
                "stack": stack.key,
                "api": base_plan.get("api", ""),
                "packages": packages,
                "files": [{"path": r.path, "purpose": r.purpose} for r in rows],
                "change": {
                    "summary": change.summary,
                    "files": [c.model_dump() for c in change.files],
                },
            }
            touched = sum(r.status == FileStatus.PLANNED for r in rows)
            version.status = AppStatus.AWAITING_APPROVAL.value
            await self._commit_with(
                session,
                app,
                version.number,
                "designed",
                f"{architect.name} planned the change: {change.summary} "
                f"({touched} file{'s' if touched != 1 else ''} to write). "
                "Waiting for the owner's approval.",
                actor=architect,
                messages=[
                    self._notice(
                        app,
                        f"The change to “{app.name}” is planned ({touched} "
                        f"file{'s' if touched != 1 else ''}). Approve it to start.",
                    )
                ],
            )
        await self._publish(build.app_id)

    async def _write(self, build: _Build, file_id: int, *, fix: bool = False) -> None:
        async with self.database.sessionmaker() as session:
            file = await session.get(AppFile, file_id)
            version = await session.get(AppVersion, build.version_id)
            app = await session.get(App, build.app_id)
            assert file is not None and version is not None and app is not None
            stack = STACKS[version.stack or ""]
            plan = version.plan or {}
            employee = await session.get(Employee, file.employee_id or "")
            if employee is None or employee.status == EmployeeStatus.SUSPENDED:
                employee = (await self._team(session, failing=True)).author(file.area)
                self._assign(file, employee)
            files = await version_files(session, version.id)
            others = sorted(
                (f for f in files if f.id != file.id and f.status == FileStatus.WRITTEN),
                key=lambda f: 0 if f.area == file.area else 1 if f.area == "backend" else 2,
            )
            rewriting = fix or file.action == "modify"
            current = file.content if rewriting and file.content.strip() else None
            problems = None
            if fix:
                problems = "\n".join(
                    part
                    for part in (
                        f"Automatic check: {file.check_error}"
                        if file.check == checks.FAILED
                        else "",
                        f"Review: {file.review_notes}" if file.review_notes else "",
                    )
                    if part
                )
            path, area, app_name = file.path, file.area, app.name
            brief = problems or file.instructions or file.purpose
            base = prompts.file_prompt(
                request=version.request,
                name=app.name,
                summary=str(plan.get("summary", "")),
                stack=stack,
                api=str(plan.get("api", "")),
                packages=list(plan.get("packages", [])),
                files=[self._info(f, content=False) for f in files],
                context=[self._info(f) for f in others],
                path=path,
                purpose=file.purpose,
                area=area,
                current=current,
                instructions=file.instructions,
                problems=problems,
            )
            file.status = (FileStatus.FIXING if fix else FileStatus.WRITING).value
            file.error = None
            await session.commit()
        await self._publish_file(build, file_id)

        async def attempt(feedback: str | None) -> str:
            text, finish = await self._ask(
                build,
                employee,
                "app_file",
                base + _feedback(feedback, "the complete file in one code block"),
                EmployeeStatus.WORKING.value,
                f"{'Fixing' if fix else 'Writing'} {path} ({app_name})",
                MAX_TOKENS["file"],
                Screen("work", f"{app_name} — {path}", brief=brief),
                thinking=False,
                file_id=file_id,
            )
            return plans.extract_file(text, path, finish)

        try:
            content = await self._attempts(build, path, attempt, file_id=file_id)
        except _StepFailed as failed:
            if fix:
                await self._file_status(file_id, FileStatus.WRITTEN)
                await self._event(
                    build,
                    "fix_failed",
                    f"{employee.name} could not rewrite {path} ({failed}); the previous "
                    "version is kept and its problems stay listed.",
                    actor=employee,
                    path=path,
                )
                await self._publish_file(build, file_id)
                return
            await self._file_status(file_id, FileStatus.FAILED, error=str(failed))
            await self._event(
                build, "file_failed", f"{path} could not be written: {failed}", path=path
            )
            await self._publish_file(build, file_id)
            raise _StepFailed(f"{failed} Press Resume to try again.") from failed
        except (_Pause, _LimitReached, asyncio.CancelledError):
            # Not written: it waits to be written again (a fix keeps the old version).
            await asyncio.shield(
                self._file_status(file_id, FileStatus.WRITTEN if fix else FileStatus.PLANNED)
            )
            raise

        async with self.database.sessionmaker() as session:
            file = await session.get(AppFile, file_id)
            assert file is not None
            file.content = content
            file.status = FileStatus.WRITTEN.value
            file.check = file.check_error = None
            if fix:
                file.revisions += 1
            await session.commit()
        lines = len(content.splitlines())
        await self._event(
            build,
            "fixed" if fix else "written",
            f"{employee.name} ({employee.role}) {'rewrote' if rewriting else 'wrote'} {path} "
            f"({lines} line{'s' if lines != 1 else ''}).",
            actor=employee,
            path=path,
        )
        await self._publish_file(build, file_id)
        await self._publish(build.app_id)

    async def _check(self, build: _Build) -> None:
        async with self.database.sessionmaker() as session:
            version = await session.get(AppVersion, build.version_id)
            assert version is not None
            stack = STACKS[version.stack or ""]
            files = await version_files(session, version.id)
            tree = written_tree(files)
            pending = [f.path for f in files if f.status == FileStatus.WRITTEN and f.check is None]
        if not pending:
            return
        report = await self.check(tree, stack, self.scratch)
        results = {path: report.files.get(path, (checks.SKIPPED, None)) for path in pending}
        async with self.database.sessionmaker() as session:
            for file in await version_files(session, build.version_id):
                if file.path in results and file.check is None:
                    file.check, file.check_error = results[file.path]
            await session.commit()
        text = f"Automatic syntax checks: {checks.Report(files=results).summary()}."
        failed = [
            f"{path}: {error}" for path, (state, error) in results.items() if state == checks.FAILED
        ]
        if failed:
            text += " " + " · ".join(failed)
        if not report.sandboxed and any(p.lower().endswith(checks.CODE) for p in pending):
            text += " Code files were not checked: the sandbox isn't available."
        await self._event(build, "checked", text)
        await self._publish(build.app_id)

    async def _review(self, build: _Build) -> None:
        async with self.database.sessionmaker() as session:
            version = await session.get(AppVersion, build.version_id)
            app = await session.get(App, build.app_id)
            assert version is not None and app is not None
            stack = STACKS[version.stack or ""]
            plan = version.plan or {}
            reviewer = (await self._team(session, failing=True)).reviewer
            files = [
                f
                for f in await version_files(session, version.id)
                if f.status == FileStatus.WRITTEN
            ]
            changed = (
                [f.path for f in files if f.action != "keep"]
                if version.base_version is not None
                else None
            )
            # What changed comes first, so it is what fits when the app is large.
            ordered = sorted(files, key=lambda f: f.action == "keep")
            prompt = prompts.review_prompt(
                name=app.name,
                summary=str(plan.get("summary", "")),
                stack=stack,
                api=str(plan.get("api", "")),
                files=[self._info(f) for f in ordered],
                checks=[f"{f.path}: {f.check_error}" for f in files if f.check == checks.FAILED],
                changed=changed,
            )
            paths = {f.path for f in files}
            name = app.name
            brief = "\n\n".join(f"{f.path}\n{f.content}" for f in ordered)

        async def attempt(feedback: str | None) -> plans.AppReview:
            text, _ = await self._ask(
                build,
                reviewer,
                "app_review",
                prompt + _feedback(feedback),
                EmployeeStatus.REVIEWING.value,
                f"Reviewing the app: {name}",
                MAX_TOKENS["review"],
                Screen("review", f"Review: {name}", brief=brief),
            )
            return plans.parse_review(text, paths)

        try:
            review = await self._attempts(build, "Review", attempt)
        except _StepFailed as failed:
            await self._mark(build, reviewed=True)
            await self._event(
                build,
                "review_skipped",
                f"The review could not be completed ({failed}); the app is delivered "
                "without a review.",
                actor=reviewer,
            )
            return
        notes: dict[str, list[str]] = {}
        for issue in review.issues:
            notes.setdefault(issue.path, []).append(issue.problem.strip())
        async with self.database.sessionmaker() as session:
            for file in await version_files(session, build.version_id):
                if file.path in notes:
                    file.review_notes = "\n".join(notes[file.path])
            version = await session.get(AppVersion, build.version_id)
            assert version is not None
            version.reviewed_at = now()
            await session.commit()
        await self._event(
            build,
            "reviewed",
            f"{reviewer.name} ({reviewer.role}) reviewed the app: "
            + (
                f"{len(review.issues)} problem{'s' if len(review.issues) != 1 else ''} in "
                + ", ".join(sorted(notes))
                + "."
                if notes
                else "no problems found."
            ),
            actor=reviewer,
        )
        await self._publish(build.app_id)

    async def _fix(self, build: _Build) -> None:
        async with self.database.sessionmaker() as session:
            targets = [
                f.id
                for f in await version_files(session, build.version_id)
                if f.status == FileStatus.WRITTEN
                and f.revisions < MAX_REVISIONS
                and (f.check == checks.FAILED or f.review_notes)
            ]
        for file_id in targets:
            await self._write(build, file_id, fix=True)
        if targets:
            await self._check(build)
        await self._mark(build, fixed=True)

    async def _deliver(self, build: _Build) -> None:
        async with self.database.sessionmaker() as session:
            version = await session.get(AppVersion, build.version_id)
            app = await session.get(App, build.app_id)
            assert version is not None and app is not None
            plan = version.plan or {}
            lead = (await self._team(session, failing=True)).lead
            files = await version_files(session, version.id)
            written = [f for f in files if f.action != "keep" and f.status == FileStatus.WRITTEN]
            change = plan.get("change") or {}
            prompt = prompts.delivery_prompt(
                name=app.name,
                request=version.request,
                summary=str(plan.get("summary", "")),
                files=[self._info(f) for f in written],
                change=str(change.get("summary")) if change else None,
                problems=known_issues(files),
            )
            name, stored = app.name, len(files)

        async def attempt(_: str | None) -> str:
            text, _finish = await self._ask(
                build,
                lead,
                "app_delivery",
                prompt,
                EmployeeStatus.WORKING.value,
                f"Writing the delivery note: {name}",
                MAX_TOKENS["delivery"],
                Screen("report", f"Delivery note: {name}", brief=prompt[-1200:]),
                thinking=False,
            )
            note = clean_text(text)
            if not note:
                raise GatewayError("empty", "The model returned only the format line.")
            return note

        try:
            note = await self._attempts(build, "Delivery note", attempt)
        except _StepFailed as failed:
            note = (
                f"*The delivery note could not be written ({failed}).* The app's {stored} "
                "files are stored; the list of files shows who wrote each one and what "
                "the checks found."
            )
            await self._event(build, "delivery_note_missing", note.strip("*"), actor=lead)
        async with self.database.sessionmaker() as session:
            version = await session.get(AppVersion, build.version_id)
            assert version is not None
            version.summary = note
            await session.commit()

    async def _ready(self, build: _Build) -> None:
        async with self.database.sessionmaker() as session:
            version = await session.get(AppVersion, build.version_id)
            app = await session.get(App, build.app_id)
            if version is None or app is None or version.status not in APP_ACTIVE:
                return
            files = await version_files(session, version.id)
            issues = known_issues(files)
            version.tree_sha256 = tree_sha256(written_tree(files))
            version.status = AppStatus.READY.value
            version.status_reason = (
                f"{len(issues)} known problem{'s' if len(issues) != 1 else ''} — see the files."
                if issues
                else None
            )
            version.finished_at = now()
            lead = (await self._team(session, failing=True)).lead
            messages = [
                Message(
                    conversation_id=app.source_conversation_id,
                    role=MessageRole.AGENT.value,
                    employee_id=lead.id,
                    author_name=lead.name,
                    author_role=lead.role,
                    author_department=lead.department,
                    content=f"**App ready — {app.name}** (version {version.number})\n\n"
                    f"{version.summary or ''}\n\n[Open app](/apps/{app.id})",
                    status=MessageStatus.COMPLETE.value,
                    model_source="app",
                    finished_at=now(),
                )
            ]
            await self._commit_with(
                session,
                app,
                version.number,
                "ready",
                f"Version {version.number} of “{app.name}” is ready: {len(files)} files stored."
                + (f" {len(issues)} known problem(s) are listed on the files." if issues else ""),
                actor=lead,
                messages=messages,
            )
        if self.artifacts:
            try:
                await self.artifacts.register_app_version(build.version_id)
            except Exception:
                log.exception("app.artifact_registration_failed", version_id=build.version_id)
        await self.activity.flash(lead.id, EmployeeStatus.COMPLETED.value, f"Delivered {app.name}")
        await self._publish(build.app_id)

    # ================================================================= helpers

    async def _attempts[T](
        self,
        build: _Build,
        label: str,
        attempt: Callable[[str | None], Awaitable[T]],
        *,
        file_id: int | None = None,
    ) -> T:
        """The retry policy: transient errors and unusable replies get one more try;
        refusals that need the owner pause the build; anything else fails the step."""
        feedback: str | None = None
        for number in range(1, MAX_ATTEMPTS + 1):
            await self._count_attempt(build, file_id)
            try:
                return await attempt(feedback)
            except GatewayError as error:
                if error.kind in PAUSE_KINDS:
                    raise _Pause(str(error)) from error
                reason = str(error)
                if error.kind not in RETRY_KINDS or number == MAX_ATTEMPTS:
                    raise _StepFailed(f"{label}: {reason}") from error
            except PlanError as error:
                reason = feedback = str(error)
                if number == MAX_ATTEMPTS:
                    raise _StepFailed(f"{label}: unusable reply — {reason}") from error
            await self._event(
                build,
                "retry",
                f"{label}: {reason} Retrying (attempt {number + 1} of {MAX_ATTEMPTS}).",
            )
        raise _StepFailed(f"{label}: failed")  # pragma: no cover - the loop returns or raises

    async def _count_attempt(self, build: _Build, file_id: int | None) -> None:
        async with self.database.sessionmaker() as session:
            if file_id is not None:
                file = await session.get(AppFile, file_id)
                if file:
                    file.attempts += 1
            else:
                version = await session.get(AppVersion, build.version_id)
                if version and version.plan is None:
                    version.plan_attempts += 1
            await session.commit()

    async def _ask(
        self,
        build: _Build,
        employee: Employee,
        purpose: str,
        prompt: str,
        status: str,
        detail: str,
        max_tokens: int,
        screen: Screen | None = None,
        *,
        thinking: bool = True,
        file_id: int | None = None,
    ) -> tuple[str, str | None]:
        """One model request for this version: (text, finish reason)."""
        if time.monotonic() > self._deadline.get(build.version_id, math.inf):
            raise _StepFailed(
                f"Stopped: the build ran longer than {MAX_RUN_SECONDS // 60} minutes."
            )
        async with self._calls, self.database.sessionmaker() as session:
            version = await session.get(AppVersion, build.version_id)
            if version is None or version.calls_used >= version.max_calls:
                raise _LimitReached
            version.calls_used += 1
            await session.commit()
        # Streamed, so the employee's monitor shows the code as it is written.
        token = await self.activity.begin(employee.id, status, detail, screen)
        completion = None
        written = ""
        events = None
        try:
            async with self.database.sessionmaker() as session:
                _, events = await self.gateway.stream(
                    session,
                    [{"role": "user", "content": prompt}],
                    employee_id=employee.id,
                    purpose=purpose,
                    context=prompts.RULES,
                    max_tokens=max_tokens,
                    thinking=thinking,
                )
            async for event in events:
                if event.kind == "reasoning":
                    self.activity.update_screen(employee.id, token, thinking=True)
                elif event.kind == "text" and event.text:
                    written += event.text
                    self.activity.update_screen(employee.id, token, text=written)
                elif event.kind == "done":
                    completion = event.completion
        finally:
            if events is not None:
                await events.aclose()  # type: ignore[attr-defined]
            await self.activity.end(employee.id, token, screen_failed=completion is None)
        if completion is None:
            raise GatewayError("provider_unavailable", "The reply stream ended unexpectedly.")
        async with self.database.sessionmaker() as session:
            version = await session.get(AppVersion, build.version_id)
            if version:
                version.prompt_tokens += completion.prompt_tokens or 0
                version.completion_tokens += completion.completion_tokens or 0
            if file_id is not None:
                file = await session.get(AppFile, file_id)
                if file:
                    file.calls += 1
                    file.prompt_tokens += completion.prompt_tokens or 0
                    file.completion_tokens += completion.completion_tokens or 0
            await session.commit()
        text = (completion.content or "").strip()
        if not text:
            raise GatewayError(
                "empty",
                "The model returned no visible text (its reasoning used the output tokens).",
            )
        return text, completion.finish_reason

    async def _team(self, session: AsyncSession, *, failing: bool = False) -> roles.Team:
        try:
            return await roles.team(session)
        except roles.NoTeam as error:
            if failing:
                raise _StepFailed(str(error)) from error
            raise AppError(str(error)) from error

    def _new_version(
        self, app_id: str, number: int, request: str, architect: Employee, max_calls: int
    ) -> AppVersion:
        return AppVersion(
            id=new_id("apv"),
            app_id=app_id,
            number=number,
            request=request,
            status=AppStatus.PLANNING.value,
            architect_id=architect.id,
            max_calls=max_calls,
            calls_used=0,
            prompt_tokens=0,
            completion_tokens=0,
            plan_attempts=0,
        )

    @staticmethod
    def _assign(file: AppFile, employee: Employee) -> None:
        file.employee_id = employee.id
        file.author_name = employee.name
        file.author_role = employee.role

    def _file_row(
        self, version_id: str, stack: Stack, path: str, purpose: str, author: Employee
    ) -> AppFile:
        row = AppFile(
            version_id=version_id,
            path=path,
            area=area_of(stack, path),
            purpose=purpose.strip(),
            action="new",
            status=FileStatus.PLANNED.value,
            content="",
        )
        self._assign(row, author)
        return row

    @staticmethod
    def _ordered[T](stack: Stack, items: list[tuple[str, T]]) -> list[T]:
        """Writing order: backend, frontend, setup, docs — then as listed."""
        ranked = sorted(
            enumerate(items),
            key=lambda entry: (WRITE_ORDER.index(area_of(stack, entry[1][0])), entry[0]),
        )
        return [item for _, (_, item) in ranked]

    @staticmethod
    def _info(file: AppFile, *, content: bool = True) -> FileInfo:
        written = file.status == FileStatus.WRITTEN
        return FileInfo(
            path=file.path,
            purpose=file.purpose,
            author=file.author_name or "unassigned",
            role=file.author_role or "",
            written=written,
            content=file.content if content and written else "",
        )

    async def _settle_files(self, session: AsyncSession, version_id: str) -> None:
        """Files caught mid-write wait to be written again; a fix keeps the old version."""
        for file in await version_files(session, version_id):
            if file.status == FileStatus.WRITING:
                file.status = FileStatus.PLANNED.value
            elif file.status == FileStatus.FIXING:
                file.status = FileStatus.WRITTEN.value

    async def _file_status(
        self, file_id: int, status: FileStatus, *, error: str | None = None
    ) -> None:
        async with self.database.sessionmaker() as session:
            file = await session.get(AppFile, file_id)
            if file is not None:
                file.status = status.value
                file.error = error
                await session.commit()

    async def _mark(self, build: _Build, *, reviewed: bool = False, fixed: bool = False) -> None:
        async with self.database.sessionmaker() as session:
            version = await session.get(AppVersion, build.version_id)
            if version is not None:
                if reviewed:
                    version.reviewed_at = now()
                if fixed:
                    version.fixed_at = now()
                await session.commit()

    async def _status(self, build: _Build, status: AppStatus) -> None:
        async with self.database.sessionmaker() as session:
            version = await session.get(AppVersion, build.version_id)
            if version is None or version.status not in APP_ACTIVE or version.status == status:
                return
            version.status = status.value
            await session.commit()
        await self._publish(build.app_id)

    async def _pause(self, build: _Build, reason: str) -> None:
        async with self.database.sessionmaker() as session:
            version = await session.get(AppVersion, build.version_id)
            app = await session.get(App, build.app_id)
            if version is None or app is None or version.status not in APP_ACTIVE:
                return
            version.status = AppStatus.PAUSED.value
            version.status_reason = f"Paused: {reason} Press Resume when this is resolved."
            await self._settle_files(session, version.id)
            await self._commit_with(
                session,
                app,
                build.number,
                "paused",
                f"Paused: {reason}",
                messages=[self._notice(app, f"App build paused: {reason}")],
            )
        await self._publish(build.app_id)

    async def _fail(self, build: _Build, reason: str) -> None:
        async with self.database.sessionmaker() as session:
            version = await session.get(AppVersion, build.version_id)
            app = await session.get(App, build.app_id)
            if version is None or app is None or version.status in APP_FINISHED:
                return
            version.status = AppStatus.FAILED.value
            version.status_reason = reason
            version.finished_at = now()
            await self._settle_files(session, version.id)
            await self._commit_with(
                session,
                app,
                build.number,
                "failed",
                reason,
                messages=[self._notice(app, f"App build failed: {reason}")],
            )
        await self._publish(build.app_id)

    async def _get(self, session: AsyncSession, app_id: str) -> App:
        app = await session.get(App, app_id)
        if app is None:
            raise AppError("App not found.", 404)
        return app

    async def _commit_with(
        self,
        session: AsyncSession,
        app: App,
        number: int,
        kind: str,
        text: str,
        *,
        actor: Employee | None = None,
        messages: list[Message] | None = None,
    ) -> None:
        """Commits a status change together with its timeline event and any chat
        messages, so no one ever sees one without the others."""
        event = AppEvent(
            app_id=app.id,
            version=number,
            kind=kind,
            actor_id=actor.id if actor else None,
            actor_name=actor.name if actor else None,
            text=text[:4000],
        )
        session.add(event)
        conversation = None
        if messages and app.source_conversation_id:
            conversation = await session.get(Conversation, app.source_conversation_id)
            if conversation is not None:
                for message in messages:
                    session.add(message)
                conversation.last_message_at = now()
        await session.commit()
        await session.refresh(event)
        self.events.publish("app.event", event_out(event))
        log.info("apps.event", app_id=app.id, kind=kind)
        if conversation is not None and messages and self.chat is not None:
            for message in messages:
                await session.refresh(message)
                await self.chat.publish_message(session, message, "message.created")
            await self.chat._publish_conversation(session, conversation)

    def _notice(self, app: App, text: str) -> Message:
        """A system notice for the source conversation (never a model's words)."""
        return Message(
            conversation_id=app.source_conversation_id,
            role=MessageRole.SYSTEM.value,
            content=f"{text} [Open app](/apps/{app.id})",
            status=MessageStatus.COMPLETE.value,
            finished_at=now(),
        )

    # ---------------------------------------------------------- notifications

    async def _event(
        self,
        build: _Build,
        kind: str,
        text: str,
        *,
        actor: Employee | None = None,
        path: str | None = None,
    ) -> None:
        async with self.database.sessionmaker() as session:
            event = AppEvent(
                app_id=build.app_id,
                version=build.number,
                kind=kind,
                actor_id=actor.id if actor else None,
                actor_name=actor.name if actor else None,
                path=path,
                text=text[:4000],
            )
            session.add(event)
            await session.commit()
            await session.refresh(event)
            self.events.publish("app.event", event_out(event))
        log.info("apps.event", app_id=build.app_id, kind=kind)

    async def _publish_file(self, build: _Build, file_id: int) -> None:
        """Re-reads the file (server-set timestamps) before announcing it."""
        async with self.database.sessionmaker() as session:
            file = await session.get(AppFile, file_id)
            if file is not None:
                self.events.publish(
                    "app.file", {"app_id": build.app_id, "version": build.number, **file_out(file)}
                )

    async def _publish(self, app_id: str) -> None:
        async with self.database.sessionmaker() as session:
            app = await session.get(App, app_id)
            if app is not None:
                self.events.publish("app.updated", await app_summary(session, app))


# =================================================================== output


def _stamp(value: Any) -> str | None:
    return value.isoformat() if value else None


def event_out(event: AppEvent) -> dict[str, Any]:
    return {
        "id": event.id,
        "app_id": event.app_id,
        "version": event.version,
        "created_at": event.created_at.isoformat() if event.created_at else now().isoformat(),
        "kind": event.kind,
        "actor_id": event.actor_id,
        "actor_name": event.actor_name,
        "path": event.path,
        "text": event.text,
    }


def file_out(file: AppFile) -> dict[str, Any]:
    """A file without its content (fetched separately when the owner opens it)."""
    return {
        "id": file.id,
        "path": file.path,
        "area": file.area,
        "purpose": file.purpose,
        "action": file.action,
        "instructions": file.instructions,
        "employee_id": file.employee_id,
        "author_name": file.author_name,
        "author_role": file.author_role,
        "status": file.status,
        "error": file.error,
        "size": len(file.content),
        "lines": len(file.content.splitlines()),
        "check": file.check,
        "check_error": file.check_error,
        "review_notes": file.review_notes,
        "revisions": file.revisions,
        "attempts": file.attempts,
        "calls": file.calls,
    }


def version_out(version: AppVersion) -> dict[str, Any]:
    return {
        "number": version.number,
        "base_version": version.base_version,
        "request": version.request,
        "status": version.status,
        "status_reason": version.status_reason,
        "stack": version.stack,
        "summary": version.summary,
        "tree_sha256": version.tree_sha256,
        "calls_used": version.calls_used,
        "max_calls": version.max_calls,
        "prompt_tokens": version.prompt_tokens,
        "completion_tokens": version.completion_tokens,
        "created_at": _stamp(version.created_at),
        "approved_at": _stamp(version.approved_at),
        "finished_at": _stamp(version.finished_at),
    }


async def app_summary(session: AsyncSession, app: App) -> dict[str, Any]:
    # The status is read first and everything else after it: SQLite gives each query the
    # latest committed state, so whoever waits for a status never sees older details.
    version = await latest_version(session, app.id)
    await session.refresh(app)
    files = await version_files(session, version.id) if version else []
    ready = await session.scalar(
        select(AppVersion.number)
        .where(AppVersion.app_id == app.id, AppVersion.status == AppStatus.READY.value)
        .order_by(AppVersion.number.desc())
        .limit(1)
    )
    return {
        "id": app.id,
        "name": app.name,
        "description": app.description,
        "version": version.number if version else app.current_version,
        "ready_version": ready,
        "status": version.status if version else AppStatus.FAILED.value,
        "status_reason": version.status_reason if version else None,
        "stack": version.stack if version else None,
        "files": {
            "total": len(files),
            "written": sum(f.status == FileStatus.WRITTEN for f in files),
            "failed": sum(f.status == FileStatus.FAILED for f in files),
        },
        "calls_used": version.calls_used if version else 0,
        "max_calls": version.max_calls if version else 0,
        "prompt_tokens": version.prompt_tokens if version else 0,
        "completion_tokens": version.completion_tokens if version else 0,
        "source_conversation_id": app.source_conversation_id,
        "created_at": _stamp(app.created_at),
        "finished_at": _stamp(version.finished_at) if version else None,
    }


def estimate_calls(files: list[AppFile], version: AppVersion) -> dict[str, int]:
    """Model requests still to come: a typical run and the worst case the limits allow."""
    writes = sum(f.status in (FileStatus.PLANNED, FileStatus.FAILED) for f in files)
    typical = writes + 2  # the review and the delivery note
    worst = MAX_ATTEMPTS * (writes + len(files) * MAX_REVISIONS + 2)
    left = max(0, version.max_calls - version.calls_used)
    return {"typical": min(typical, left), "worst": min(worst, left)}
