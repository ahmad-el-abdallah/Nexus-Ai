"""Code runs: the owner approves an employee's exact code, then it runs in the sandbox.

Approval is enforced here: a run is created as `pending_approval` for code that
appears verbatim in an employee's reply or task result, and only `approve` with the
SHA-256 of that stored code moves it to `running` (atomically, once). One run at a
time, so the machine stays responsive.
"""

from __future__ import annotations

import asyncio
import hashlib
import shutil
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events import EventBus
from app.core.logging import get_logger
from app.db.session import Database
from app.models import CodeRun, Message, MessageRole, RunStatus, Task
from app.sandbox import runner

log = get_logger("nexus.sandbox")

MAX_CODE = 100_000


class RunError(Exception):
    def __init__(self, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.status = status


def sha256(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def run_out(r: CodeRun) -> dict[str, Any]:
    return {
        "id": r.id,
        "language": r.language,
        "code": r.code,
        "code_sha256": r.code_sha256,
        "status": r.status,
        "message_id": r.message_id,
        "task_id": r.task_id,
        "employee_id": r.employee_id,
        "author_name": r.author_name,
        "exit_code": r.exit_code,
        "duration_ms": r.duration_ms,
        "stdout": r.stdout,
        "stderr": r.stderr,
        "files": r.files,
        "error": r.error,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "approved_at": r.approved_at.isoformat() if r.approved_at else None,
        "finished_at": r.finished_at.isoformat() if r.finished_at else None,
    }


def limits() -> dict[str, Any]:
    return {
        "timeout_seconds": runner.TIMEOUT_S,
        "memory": runner.MEMORY,
        "processes": runner.TASKS,
        "network": False,
        "files": "an empty work folder only; your files are not visible",
    }


class RunService:
    def __init__(self, database: Database, events: EventBus, runs_dir: Path) -> None:
        self.database = database
        self.events = events
        self.runs_dir = runs_dir
        self._lock = asyncio.Lock()
        self._tasks: set[asyncio.Task[None]] = set()

    def capabilities(self) -> dict[str, Any]:
        caps = runner.capabilities()
        return {
            "available": caps.available,
            "languages": caps.languages,
            "reason": caps.reason,
            "limits": limits(),
        }

    async def _publish(self, run_id: str) -> None:
        async with self.database.sessionmaker() as session:
            run = await session.get(CodeRun, run_id)
            if run is not None:
                self.events.publish("run.updated", run_out(run))

    async def create(
        self,
        session: AsyncSession,
        code: str,
        language: str,
        message_id: int | None,
        task_id: str | None,
    ) -> CodeRun:
        lang = runner.language_of(language)
        caps = runner.capabilities()
        if lang is None:
            raise RunError(
                f"'{language}' code can't be run here (Python, JavaScript or Bash).", 422
            )
        if not caps.available:
            raise RunError(f"The sandbox isn't available: {caps.reason}", 409)
        if lang not in caps.languages:
            raise RunError(f"{lang} isn't installed on this computer.", 409)
        if not code.strip() or len(code) > MAX_CODE:
            raise RunError("The code is empty or too long to run.", 422)
        employee_id = author = None
        if message_id is not None:
            message = await session.get(Message, message_id)
            if message is None or message.role != MessageRole.AGENT:
                raise RunError("Only code from an employee's reply can be run.", 404)
            source, employee_id, author = message.content, message.employee_id, message.author_name
        elif task_id is not None:
            task = await session.get(Task, task_id)
            if task is None or not task.result:
                raise RunError("Only code from a finished task's result can be run.", 404)
            source, employee_id = task.result, task.assignee_id
            author = None
        else:
            raise RunError("Say which reply or task the code comes from.", 422)
        if code.strip() not in source:
            raise RunError("The code doesn't match what the employee wrote.", 422)
        run = CodeRun(
            id=f"run_{uuid.uuid4().hex[:12]}",
            language=lang,
            code=code,
            code_sha256=sha256(code),
            status=RunStatus.PENDING_APPROVAL.value,
            message_id=message_id,
            task_id=task_id,
            employee_id=employee_id,
            author_name=author,
            files=[],
        )
        session.add(run)
        await session.commit()
        await session.refresh(run)
        self.events.publish("run.updated", run_out(run))
        return run

    async def approve(self, session: AsyncSession, run_id: str, code_sha256: str) -> CodeRun:
        """The owner's approval of this exact code; the run starts."""
        run = await session.get(CodeRun, run_id)
        if run is None:
            raise RunError("Run not found", 404)
        if run.code_sha256 != code_sha256:
            raise RunError("The approved code doesn't match the code to run.", 409)
        result = await session.execute(
            update(CodeRun)
            .where(CodeRun.id == run_id, CodeRun.status == RunStatus.PENDING_APPROVAL.value)
            .values(status=RunStatus.RUNNING.value, approved_at=datetime.now(UTC))
            .execution_options(synchronize_session=False)
        )
        if result.rowcount != 1:  # type: ignore[attr-defined]
            raise RunError("This run was already approved or rejected.", 409)
        await session.commit()
        await session.refresh(run)
        log.info("sandbox.approved", run_id=run_id, language=run.language)
        task = asyncio.create_task(self._execute(run_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        await self._publish(run_id)
        return run

    async def reject(self, session: AsyncSession, run_id: str) -> CodeRun:
        run = await session.get(CodeRun, run_id)
        if run is None:
            raise RunError("Run not found", 404)
        if run.status != RunStatus.PENDING_APPROVAL:
            raise RunError("Only a run waiting for approval can be rejected.")
        run.status = RunStatus.REJECTED.value
        await session.commit()
        await session.refresh(run)
        await self._publish(run_id)
        return run

    def files_dir(self, run_id: str) -> Path:
        return self.runs_dir / run_id / "files"

    async def _execute(self, run_id: str) -> None:
        async with self._lock:  # one run at a time
            async with self.database.sessionmaker() as session:
                run = await session.get(CodeRun, run_id)
                if run is None:
                    return
                code, language = run.code, run.language
                run.started_at = datetime.now(UTC)
                await session.commit()
            work = self.runs_dir / run_id / "work"
            try:
                outcome = await asyncio.to_thread(
                    runner.run, code, language, work, self.files_dir(run_id)
                )
            except Exception as error:  # the sandbox itself failed
                log.exception("sandbox.failed", run_id=run_id)
                shutil.rmtree(work, ignore_errors=True)
                await self._save(run_id, status=RunStatus.ERROR, error=str(error))
                return
        if outcome.timed_out:
            status, error = RunStatus.TIMED_OUT, f"Stopped after {runner.TIMEOUT_S} seconds."
        elif outcome.killed:
            status, error = RunStatus.KILLED, "Stopped by a sandbox limit (memory or processes)."
        elif outcome.exit_code == 0:
            status, error = RunStatus.SUCCEEDED, None
        else:
            status, error = RunStatus.FAILED, None
            if "Failed to " in outcome.stderr and not outcome.stdout and outcome.exit_code == 1:
                status, error = RunStatus.ERROR, outcome.stderr.strip()[:500]
        await self._save(
            run_id,
            status=status,
            error=error,
            exit_code=outcome.exit_code,
            duration_ms=outcome.duration_ms,
            stdout=outcome.stdout,
            stderr=outcome.stderr,
            files=outcome.files,
        )

    async def _save(self, run_id: str, *, status: RunStatus, **fields: Any) -> None:
        async with self.database.sessionmaker() as session:
            run = await session.get(CodeRun, run_id)
            if run is None:
                return
            run.status = status.value
            run.finished_at = datetime.now(UTC)
            for name, value in fields.items():
                setattr(run, name, value)
            await session.commit()
        log.info("sandbox.finished", run_id=run_id, status=status.value)
        await self._publish(run_id)

    async def recover(self) -> None:
        from sqlalchemy import select

        async with self.database.sessionmaker() as session:
            for run in await session.scalars(
                select(CodeRun).where(CodeRun.status == RunStatus.RUNNING.value)
            ):
                run.status = RunStatus.ERROR.value
                run.error = "NEXUS restarted during the run."
                run.finished_at = datetime.now(UTC)
            await session.commit()

    async def shutdown(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
