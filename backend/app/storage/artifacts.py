"""Register real employee-produced artifacts in the Digital Vault.

Source models remain authoritative. This adapter copies only bytes that actually
exist, records immutable Vault versions, and attaches provenance links back to
the source records. It never accepts an operating-system path from an agent.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import Database
from app.models import (
    App,
    AppFile,
    AppStatus,
    AppVersion,
    Attachment,
    CodeRun,
    Conversation,
    Employee,
    FileStatus,
    Message,
    StorageEntry,
    StorageLink,
    Task,
    TaskStatus,
    Workflow,
    WorkflowStatus,
)
from app.storage.errors import VaultError
from app.storage.names import StorageNameError, logical_name
from app.storage.service import SYSTEM_ACTOR, StorageActor, VaultDownload, VaultService

log = structlog.get_logger(__name__)


@dataclass
class RegistrationSummary:
    registered: int = 0
    failed: int = 0

    def add(self, other: RegistrationSummary) -> None:
        self.registered += other.registered
        self.failed += other.failed


@dataclass(frozen=True)
class ArtifactLink:
    target_type: str
    target_id: str
    relation: str
    label: str | None = None


class ArtifactRegistrar:
    """Permission-aware bridge from persistent source records to Vault files."""

    def __init__(
        self,
        database: Database,
        vault: VaultService,
        runs_dir: Path,
    ) -> None:
        self.database = database
        self.vault = vault
        self.runs_dir = runs_dir
        self._lock = asyncio.Lock()

    async def recover(self) -> RegistrationSummary:
        """Idempotently backfill all complete, real artifacts after startup."""
        summary = RegistrationSummary()
        async with self.database.sessionmaker() as session:
            attachment_ids = list(await session.scalars(select(Attachment.id)))
            task_ids = list(
                await session.scalars(
                    select(Task.id).where(
                        Task.status == TaskStatus.DONE.value,
                        Task.result.is_not(None),
                    )
                )
            )
            workflow_ids = list(
                await session.scalars(
                    select(Workflow.id).where(
                        Workflow.status.in_(
                            [
                                WorkflowStatus.COMPLETED.value,
                                WorkflowStatus.COMPLETED_WITH_FAILURES.value,
                            ]
                        ),
                        Workflow.result.is_not(None),
                    )
                )
            )
            version_ids = list(
                await session.scalars(
                    select(AppVersion.id).where(AppVersion.status == AppStatus.READY.value)
                )
            )
            run_ids = [run.id for run in await session.scalars(select(CodeRun)) if run.files]
        for source_id, register in (
            *((source_id, self.register_attachment) for source_id in attachment_ids),
            *((source_id, self.register_task) for source_id in task_ids),
            *((source_id, self.register_workflow) for source_id in workflow_ids),
            *((source_id, self.register_app_version) for source_id in version_ids),
            *((source_id, self.register_code_run) for source_id in run_ids),
        ):
            summary.add(await register(source_id))
        log.info(
            "vault.artifacts.recovered",
            registered=summary.registered,
            failed=summary.failed,
        )
        return summary

    async def register_attachment(self, attachment_id: str) -> RegistrationSummary:
        async with self._lock, self.database.sessionmaker() as session:
            attachment = await session.get(Attachment, attachment_id)
            if attachment is None:
                return RegistrationSummary()
            message = await session.get(Message, attachment.message_id)
            conversation = (
                await session.get(Conversation, message.conversation_id) if message else None
            )
            if message is None or conversation is None:
                return await self._failed(
                    session,
                    "ws_company",
                    "attachment",
                    attachment_id,
                    "Could not register an attachment because its source message is missing.",
                )
            workspace_id = f"ws_department:{conversation.department}"
            filename = self._identified_filename(attachment.filename, attachment.id)
            return await self._register_bytes(
                session,
                workspace_id=workspace_id,
                actor=SYSTEM_ACTOR,
                folders=["AI Artifacts", "Chat Attachments", conversation.id],
                filename=filename,
                data=attachment.data,
                content_type=attachment.content_type,
                description=f"Owner attachment: {attachment.filename}",
                artifact_type="chat-attachment",
                tags=["source-attachment", "chat"],
                primary=ArtifactLink(
                    "message",
                    str(message.id),
                    f"attachment-{attachment.id[-8:]}",
                    attachment.filename,
                ),
                links=[],
                change_description="Source attachment changed.",
            )

    async def register_task(self, task_id: str) -> RegistrationSummary:
        async with self._lock, self.database.sessionmaker() as session:
            task = await session.get(Task, task_id)
            if task is None or task.status != TaskStatus.DONE.value or not task.result:
                return RegistrationSummary()
            actor = await self._actor(session, task.assignee_id, "NEXUS task worker")
            return await self._register_bytes(
                session,
                workspace_id=f"ws_department:{task.department}",
                actor=actor,
                folders=["AI Artifacts", "Tasks"],
                filename=f"{self._segment(task.title, task.id)} — {task.id}.md",
                data=task.result.encode("utf-8"),
                content_type="text/markdown",
                description=f"Completed task deliverable: {task.title}",
                artifact_type="task-result",
                tags=["ai-generated", "task", task.department],
                primary=ArtifactLink("task", task.id, "result", task.title),
                links=[],
                change_description="Task result updated.",
            )

    async def register_workflow(self, workflow_id: str) -> RegistrationSummary:
        async with self._lock, self.database.sessionmaker() as session:
            workflow = await session.get(Workflow, workflow_id)
            if (
                workflow is None
                or workflow.status
                not in {
                    WorkflowStatus.COMPLETED.value,
                    WorkflowStatus.COMPLETED_WITH_FAILURES.value,
                }
                or not workflow.result
            ):
                return RegistrationSummary()
            actor = await self._system_actor(session, workflow.ceo_id, "NEXUS CEO")
            links = []
            if workflow.source_task_id:
                links.append(ArtifactLink("task", workflow.source_task_id, "source", "Source task"))
            return await self._register_bytes(
                session,
                workspace_id="ws_company",
                actor=actor,
                folders=["AI Artifacts", "Workflows"],
                filename=f"{self._segment(workflow.title, workflow.id)} — {workflow.id}.md",
                data=workflow.result.encode("utf-8"),
                content_type="text/markdown",
                description=f"CEO workflow report: {workflow.title}",
                artifact_type="workflow-report",
                tags=["ai-generated", "workflow", "company"],
                primary=ArtifactLink("workflow", workflow.id, "report", workflow.title),
                links=links,
                change_description="Workflow report updated.",
            )

    async def register_app_version(self, version_id: str) -> RegistrationSummary:
        async with self._lock, self.database.sessionmaker() as session:
            version = await session.get(AppVersion, version_id)
            if version is None or version.status != AppStatus.READY.value:
                return RegistrationSummary()
            app = await session.get(App, version.app_id)
            if app is None:
                return RegistrationSummary()
            files = list(
                await session.scalars(
                    select(AppFile)
                    .where(AppFile.version_id == version.id)
                    .order_by(AppFile.position, AppFile.id)
                )
            )
            summary = RegistrationSummary()
            for file in files:
                if file.status != FileStatus.WRITTEN.value:
                    summary.add(
                        await self._failed(
                            session,
                            "ws_department:engineering",
                            "app_file",
                            str(file.id),
                            f"Did not register {file.path}: the app file was not written.",
                        )
                    )
                    continue
                parts = [self._segment(part, "file") for part in file.path.split("/")]
                filename = self._vault_filename(parts[-1])
                actor = await self._actor(session, file.employee_id, file.author_name or "Engineer")
                result = await self._register_bytes(
                    session,
                    workspace_id="ws_department:engineering",
                    actor=actor,
                    folders=[
                        "AI Artifacts",
                        "Apps",
                        f"{self._segment(app.name, app.id)} — {app.id}",
                        f"Version {version.number}",
                        *parts[:-1],
                    ],
                    filename=filename,
                    data=file.content.encode("utf-8"),
                    content_type=None,
                    description=f"{file.path} from {app.name} version {version.number}. {file.purpose}",
                    artifact_type="app-source",
                    tags=["ai-generated", "app", "engineering", file.area],
                    primary=ArtifactLink("app_file", str(file.id), "source", file.path),
                    links=[
                        ArtifactLink("app", app.id, "app", app.name),
                        ArtifactLink(
                            "app_version", version.id, "version", f"Version {version.number}"
                        ),
                    ],
                    change_description=f"App source updated from {file.path}.",
                )
                summary.add(result)
            return summary

    async def register_code_run(self, run_id: str) -> RegistrationSummary:
        async with self._lock, self.database.sessionmaker() as session:
            run = await session.get(CodeRun, run_id)
            if run is None or not run.files:
                return RegistrationSummary()
            actor = await self._actor(session, run.employee_id, run.author_name or "Code runner")
            department = actor.department_key
            if department is None and run.task_id:
                task = await session.get(Task, run.task_id)
                department = task.department if task else None
            workspace_id = f"ws_department:{department}" if department else "ws_company"
            files_dir = self.runs_dir / run.id / "files"
            summary = RegistrationSummary()
            for item in run.files:
                raw_name = item.get("name")
                if not isinstance(raw_name, str) or Path(raw_name).name != raw_name:
                    summary.add(
                        await self._failed(
                            session,
                            workspace_id,
                            "code_run",
                            run.id,
                            "Did not register a code-run output with an invalid file name.",
                        )
                    )
                    continue
                source = files_dir / raw_name
                try:
                    resolved = source.resolve(strict=True)
                    if resolved.parent != files_dir.resolve() or resolved.is_symlink():
                        raise OSError("unsafe output path")
                    data = await asyncio.to_thread(resolved.read_bytes)
                except OSError:
                    summary.add(
                        await self._failed(
                            session,
                            workspace_id,
                            "code_run",
                            run.id,
                            f"Did not register {raw_name}: the recorded output file is missing or unsafe.",
                        )
                    )
                    continue
                links: list[ArtifactLink] = []
                if run.task_id:
                    links.append(ArtifactLink("task", run.task_id, "source", "Source task"))
                if run.message_id is not None:
                    links.append(
                        ArtifactLink("message", str(run.message_id), "source", "Source message")
                    )
                result = await self._register_bytes(
                    session,
                    workspace_id=workspace_id,
                    actor=actor,
                    folders=["AI Artifacts", "Code Runs", run.id],
                    filename=self._vault_filename(raw_name),
                    data=data,
                    content_type=None,
                    description=f"Output produced by code run {run.id}: {raw_name}",
                    artifact_type="code-run-output",
                    tags=["ai-generated", "code-run", run.language],
                    primary=ArtifactLink(
                        "code_run", run.id, self._output_relation(raw_name), raw_name
                    ),
                    links=links,
                    change_description="Code-run output changed.",
                )
                summary.add(result)
            return summary

    # Controlled methods for future agent tool adapters. The employee identity
    # determines the workspace; callers cannot provide an operating-system path.
    async def save_text(
        self,
        employee_id: str,
        *,
        filename: str,
        content: str,
        folder: Iterable[str] = (),
        description: str | None = None,
        artifact_type: str = "document",
        tags: Iterable[str] = (),
    ) -> dict[str, Any]:
        async with self._lock, self.database.sessionmaker() as session:
            actor = await self.vault.actor_for_employee(session, employee_id)
            parent_id = await self._ensure_folders(
                session,
                f"ws_department:{actor.department_key}",
                [self._segment(value, "Folder") for value in folder],
                actor,
            )
            result = await self.vault.upload(
                session,
                f"ws_department:{actor.department_key}",
                self._vault_filename(filename),
                None,
                self._reader(content.encode("utf-8")),
                parent_id,
                description,
                actor=actor,
            )
            return await self.vault.update_entry(
                session,
                result["id"],
                name=None,
                artifact_type=artifact_type,
                tags=list(tags),
                actor=actor,
            )

    async def search(
        self, employee_id: str, *, query: str | None = None, tag: str | None = None
    ) -> dict[str, Any]:
        async with self.database.sessionmaker() as session:
            actor = await self.vault.actor_for_employee(session, employee_id)
            return await self.vault.search(
                session,
                workspace_id=None,
                query=query,
                kind="file",
                tag=tag,
                trashed=False,
                sort="updated_at",
                descending=True,
                offset=0,
                limit=100,
                actor=actor,
            )

    async def list(self, employee_id: str) -> dict[str, Any]:
        """List visible artifacts without exposing blob keys or server paths."""
        return await self.search(employee_id)

    async def create_folder(
        self,
        employee_id: str,
        *,
        name: str,
        folder: Iterable[str] = (),
    ) -> dict[str, Any]:
        async with self._lock, self.database.sessionmaker() as session:
            actor = await self.vault.actor_for_employee(session, employee_id)
            workspace_id = f"ws_department:{actor.department_key}"
            parent_id = await self._ensure_folders(
                session,
                workspace_id,
                [self._segment(value, "Folder") for value in folder],
                actor,
            )
            return await self.vault.create_folder(
                session,
                workspace_id,
                self._segment(name, "Folder"),
                parent_id,
                actor=actor,
            )

    async def update(
        self,
        employee_id: str,
        entry_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        artifact_type: str | None = None,
        tags: Iterable[str] = (),
    ) -> dict[str, Any]:
        async with self._lock, self.database.sessionmaker() as session:
            actor = await self.vault.actor_for_employee(session, employee_id)
            await self.vault.update_entry(
                session,
                entry_id,
                name=self._vault_filename(name) if name else None,
                description=description,
                artifact_type=artifact_type,
                tags=list(tags),
                actor=actor,
            )
            return await self.vault.entry_detail(session, entry_id, actor=actor)

    async def link(
        self,
        employee_id: str,
        entry_id: str,
        *,
        target_type: str,
        target_id: str,
        relation: str = "source",
        label: str | None = None,
    ) -> dict[str, Any]:
        async with self._lock, self.database.sessionmaker() as session:
            actor = await self.vault.actor_for_employee(session, employee_id)
            return await self.vault.link_entry(
                session,
                entry_id,
                target_type=target_type,
                target_id=target_id,
                relation=relation,
                label=label,
                actor=actor,
            )

    async def read(self, employee_id: str, entry_id: str) -> VaultDownload:
        async with self.database.sessionmaker() as session:
            actor = await self.vault.actor_for_employee(session, employee_id)
            return await self.vault.download(session, entry_id, actor=actor)

    async def _register_bytes(
        self,
        session: AsyncSession,
        *,
        workspace_id: str,
        actor: StorageActor,
        folders: list[str],
        filename: str,
        data: bytes,
        content_type: str | None,
        description: str,
        artifact_type: str,
        tags: list[str],
        primary: ArtifactLink,
        links: list[ArtifactLink],
        change_description: str,
    ) -> RegistrationSummary:
        try:
            await self.vault.sync_workspaces(session)
            existing = await session.scalar(
                select(StorageEntry)
                .join(StorageLink, StorageLink.entry_id == StorageEntry.id)
                .where(
                    StorageLink.target_type == primary.target_type,
                    StorageLink.target_id == primary.target_id,
                    StorageLink.relation == primary.relation,
                )
                .order_by(StorageLink.created_at.desc())
            )
            if existing is None:
                parent_id = await self._ensure_folders(session, workspace_id, folders, actor)
                view = await self.vault.upload(
                    session,
                    workspace_id,
                    filename,
                    content_type,
                    self._reader(data),
                    parent_id,
                    description,
                    actor=actor,
                )
            else:
                if existing.workspace_id != workspace_id or existing.trashed_at is not None:
                    raise VaultError(409, "The registered artifact is unavailable.")
                view = await self.vault.append_version(
                    session,
                    existing.id,
                    content_type,
                    self._reader(data),
                    change_description,
                    actor=actor,
                )
            view = await self.vault.update_entry(
                session,
                view["id"],
                name=None,
                description=description,
                artifact_type=artifact_type,
                tags=tags,
                actor=actor,
            )
            for link in [primary, *links]:
                await self.vault.link_entry(
                    session,
                    view["id"],
                    target_type=link.target_type,
                    target_id=link.target_id,
                    relation=link.relation,
                    label=link.label,
                    actor=actor,
                    managed=True,
                )
            return RegistrationSummary(registered=1)
        except (OSError, StorageNameError, VaultError) as error:
            await session.rollback()
            log.warning(
                "vault.artifact_registration_failed",
                source_type=primary.target_type,
                source_id=primary.target_id,
                error=str(error),
            )
            return await self._failed(
                session,
                workspace_id,
                primary.target_type,
                primary.target_id,
                f"Could not register {filename}: {error}",
            )

    async def _ensure_folders(
        self,
        session: AsyncSession,
        workspace_id: str,
        folders: Iterable[str],
        actor: StorageActor,
    ) -> str | None:
        parent_id: str | None = None
        parent_path = ""
        for raw_name in folders:
            name = logical_name(raw_name)
            path = f"{parent_path}/{name}" if parent_path else name
            entry = await session.scalar(
                select(StorageEntry).where(
                    StorageEntry.workspace_id == workspace_id,
                    StorageEntry.path_key == path.casefold(),
                    StorageEntry.trashed_at.is_(None),
                )
            )
            if entry is None:
                view = await self.vault.create_folder(
                    session, workspace_id, name, parent_id, actor=actor
                )
                parent_id = view["id"]
            else:
                if entry.kind != "folder":
                    raise VaultError(409, f"{path} is not a folder.")
                parent_id = entry.id
            parent_path = path
        return parent_id

    async def _failed(
        self,
        session: AsyncSession,
        workspace_id: str,
        source_type: str,
        source_id: str,
        message: str,
    ) -> RegistrationSummary:
        try:
            await self.vault.sync_workspaces(session)
            await self.vault.record_artifact_failure(
                session,
                workspace_id,
                source_type=source_type,
                source_id=source_id,
                message=message,
                actor=SYSTEM_ACTOR,
            )
        except VaultError:
            log.exception(
                "vault.artifact_failure_event_failed",
                source_type=source_type,
                source_id=source_id,
            )
        return RegistrationSummary(failed=1)

    async def _actor(
        self, session: AsyncSession, employee_id: str | None, fallback_name: str
    ) -> StorageActor:
        if employee_id:
            employee = await session.get(Employee, employee_id)
            if employee is not None:
                return StorageActor(
                    kind="employee",
                    name=employee.name,
                    employee_id=employee.id,
                    department_key=employee.department,
                )
        return StorageActor(kind="system", name=fallback_name)

    async def _system_actor(
        self, session: AsyncSession, employee_id: str | None, fallback_name: str
    ) -> StorageActor:
        """Use system authority while retaining the real employee attribution."""
        if employee_id:
            employee = await session.get(Employee, employee_id)
            if employee is not None:
                return StorageActor(
                    kind="system",
                    name=employee.name,
                    employee_id=employee.id,
                    department_key=employee.department,
                )
        return StorageActor(kind="system", name=fallback_name)

    def _vault_filename(self, value: str) -> str:
        name = self._segment(Path(value).name, "artifact")
        if Path(name).suffix.casefold() not in self.vault.settings.storage_allowed_extensions:
            name = f"{name}.txt"
        return name

    def _identified_filename(self, value: str, source_id: str) -> str:
        """Keep repeated source names distinct without exposing a storage path."""
        name = self._vault_filename(value)
        suffix = Path(name).suffix
        stem = name[: -len(suffix)] if suffix else name
        return f"{stem} — {self._segment(source_id, 'source')}{suffix}"

    @staticmethod
    def _segment(value: str, fallback: str) -> str:
        clean = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "-", value).strip(" .")
        clean = re.sub(r"\s+", " ", clean)
        return (clean or fallback)[:180]

    @staticmethod
    def _output_relation(name: str) -> str:
        import hashlib

        return f"output-{hashlib.sha256(name.encode('utf-8')).hexdigest()[:12]}"

    @staticmethod
    def _reader(data: bytes) -> Callable[[int], Awaitable[bytes]]:
        position = 0

        async def read(size: int) -> bytes:
            nonlocal position
            chunk = data[position : position + size]
            position += len(chunk)
            return chunk

        return read
