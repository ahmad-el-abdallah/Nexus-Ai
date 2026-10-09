"""Transactional Digital Vault operations over metadata and immutable blobs."""

from __future__ import annotations

import mimetypes
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.models import (
    Department,
    StorageEntry,
    StorageEntryKind,
    StorageEntryStatus,
    StorageEvent,
    StorageVersion,
    StorageVersionStatus,
    StorageWorkspace,
    StorageWorkspaceScope,
    StorageWorkspaceState,
)
from app.storage.errors import BlobLimitError, BlobMissingError, BlobUnsafeError, VaultError
from app.storage.local import LocalBlobStore
from app.storage.names import StorageNameError, logical_name, logical_path, logical_path_key

Reader = Callable[[int], Awaitable[bytes]]
UNSET = object()
MIME_PATTERN = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9.+-]*/[a-zA-Z0-9][a-zA-Z0-9.+-]*\Z")


@dataclass(frozen=True)
class VaultDownload:
    name: str
    mime_type: str
    size: int
    stream: AsyncIterator[bytes]


class VaultService:
    """The only layer allowed to coordinate storage metadata and blob bytes."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.blobs = LocalBlobStore(settings.storage_root)

    async def initialize(self) -> None:
        await self.blobs.initialize()

    async def workspaces(self, session: AsyncSession) -> list[dict[str, Any]]:
        rows = list(await session.scalars(select(StorageWorkspace).order_by(StorageWorkspace.id)))
        result: list[dict[str, Any]] = []
        for workspace in rows:
            used = await self._usage(session, workspace.id)
            result.append(
                {
                    "id": workspace.id,
                    "scope": workspace.scope,
                    "department_key": workspace.department_key,
                    "state": workspace.state,
                    "used_bytes": used,
                    "quota_bytes": self._quota(workspace),
                }
            )
        return result

    async def entries(
        self,
        session: AsyncSession,
        workspace_id: str,
        parent_id: str | None,
        *,
        trashed: bool,
    ) -> list[dict[str, Any]]:
        await self._workspace(session, workspace_id)
        if parent_id is not None:
            parent = await self._entry(session, parent_id)
            if parent.workspace_id != workspace_id or parent.kind != StorageEntryKind.FOLDER.value:
                raise VaultError(404, "Folder not found.")
        statement = select(StorageEntry).where(StorageEntry.workspace_id == workspace_id)
        if trashed:
            statement = statement.where(StorageEntry.trashed_at.is_not(None))
        else:
            statement = statement.where(
                StorageEntry.parent_id == parent_id, StorageEntry.trashed_at.is_(None)
            )
        rows = list(await session.scalars(statement.order_by(StorageEntry.kind, StorageEntry.name)))
        return [await self.entry_view(session, row) for row in rows]

    async def create_folder(
        self,
        session: AsyncSession,
        workspace_id: str,
        name: str,
        parent_id: str | None,
    ) -> dict[str, Any]:
        workspace = await self._workspace(session, workspace_id, write=True)
        safe_name = self._safe_name(name)
        parent = await self._parent(session, workspace_id, parent_id)
        path = self._child_path(parent, safe_name)
        await self._ensure_available_path(session, workspace_id, path)
        owner_kind, owner_id, owner_name = await self._owner(session, workspace)
        entry = StorageEntry(
            id=self._id("ste"),
            workspace_id=workspace_id,
            parent_id=parent_id,
            kind=StorageEntryKind.FOLDER.value,
            path=path,
            path_key=logical_path_key(path),
            name=safe_name,
            original_name=None,
            visibility=(
                "company"
                if workspace.scope == StorageWorkspaceScope.COMPANY.value
                else "department"
            ),
            status=StorageEntryStatus.AVAILABLE.value,
            current_version_number=0,
            created_by_kind="owner",
            created_by_name="Owner",
            owner_kind=owner_kind,
            owner_id=owner_id,
            owner_name=owner_name,
        )
        session.add(entry)
        session.add(
            self._event(workspace_id, entry, "folder_created", f"Created folder {safe_name}.")
        )
        await self._commit_conflict(session, "A file or folder with that name already exists.")
        await session.refresh(entry)
        return await self.entry_view(session, entry)

    async def upload(
        self,
        session: AsyncSession,
        workspace_id: str,
        filename: str,
        content_type: str | None,
        reader: Reader,
        parent_id: str | None,
        description: str | None,
    ) -> dict[str, Any]:
        workspace = await self._workspace(session, workspace_id, write=True)
        safe_name = self._safe_name(filename)
        extension = Path(safe_name).suffix.casefold()
        if extension not in self.settings.storage_allowed_extensions:
            raise VaultError(
                415, f"Files with the {extension or '(none)'} extension are not allowed."
            )
        parent = await self._parent(session, workspace_id, parent_id)
        path = self._child_path(parent, safe_name)
        await self._ensure_available_path(session, workspace_id, path)
        quota = self._quota(workspace)
        remaining = quota - await self._usage(session, workspace_id)
        if remaining <= 0:
            raise VaultError(413, "This workspace has reached its storage quota.")
        limit = min(self.settings.storage_max_file_bytes, remaining)
        try:
            blob = await self.blobs.put(reader, limit)
        except BlobLimitError as error:
            raise VaultError(
                413, "The upload exceeds the file-size or workspace quota limit."
            ) from error
        except BlobUnsafeError as error:
            raise VaultError(503, str(error)) from error
        owner_kind, owner_id, owner_name = await self._owner(session, workspace)
        entry = StorageEntry(
            id=self._id("ste"),
            workspace_id=workspace_id,
            parent_id=parent_id,
            kind=StorageEntryKind.FILE.value,
            path=path,
            path_key=logical_path_key(path),
            name=safe_name,
            original_name=safe_name,
            description=description.strip() if description and description.strip() else None,
            visibility=(
                "company"
                if workspace.scope == StorageWorkspaceScope.COMPANY.value
                else "department"
            ),
            status=StorageEntryStatus.AVAILABLE.value,
            current_version_number=1,
            created_by_kind="owner",
            created_by_name="Owner",
            owner_kind=owner_kind,
            owner_id=owner_id,
            owner_name=owner_name,
        )
        version = StorageVersion(
            id=self._id("stv"),
            entry_id=entry.id,
            number=1,
            backend=self.settings.storage_backend.value,
            storage_key=blob.key,
            original_name=safe_name,
            mime_type=self._mime(safe_name, content_type),
            size_bytes=blob.size,
            sha256=blob.sha256,
            status=StorageVersionStatus.AVAILABLE.value,
            created_by_kind="owner",
            created_by_name="Owner",
        )
        try:
            # Explicit flushes keep SQLite and PostgreSQL insertion order identical;
            # the models intentionally do not expose ORM relationships.
            session.add(entry)
            await session.flush()
            session.add(version)
            await session.flush()
            session.add(
                self._event(
                    workspace_id,
                    entry,
                    "file_uploaded",
                    f"Uploaded {safe_name}.",
                    version=version,
                    details={"size_bytes": blob.size},
                )
            )
            await self._commit_conflict(session, "A file or folder with that name already exists.")
        except IntegrityError as error:
            await session.rollback()
            await self.blobs.remove(blob.key)
            raise VaultError(409, "A file or folder with that name already exists.") from error
        except BaseException:
            await self.blobs.remove(blob.key)
            raise
        await session.refresh(entry)
        return await self.entry_view(session, entry)

    async def download(self, session: AsyncSession, entry_id: str) -> VaultDownload:
        entry = await self._entry(session, entry_id)
        if entry.kind != StorageEntryKind.FILE.value or entry.trashed_at is not None:
            raise VaultError(404, "File not found.")
        if entry.status != StorageEntryStatus.AVAILABLE.value:
            raise VaultError(409, "This file is not currently available.")
        version = await self._current_version(session, entry)
        if version is None or version.status != StorageVersionStatus.AVAILABLE.value:
            raise VaultError(409, "This file version is not currently available.")
        try:
            size, digest = await self.blobs.checksum(version.storage_key)
        except BlobMissingError as error:
            await self._mark_unavailable(
                session,
                entry,
                version,
                StorageVersionStatus.MISSING.value,
                "Stored content is missing.",
            )
            raise VaultError(
                409, "The stored file is missing; run storage reconciliation."
            ) from error
        except BlobUnsafeError as error:
            await self._mark_unavailable(
                session,
                entry,
                version,
                StorageVersionStatus.QUARANTINED.value,
                "Stored content failed path validation.",
            )
            raise VaultError(409, "The stored file failed path validation.") from error
        if size != version.size_bytes or digest != version.sha256:
            await self._mark_unavailable(
                session,
                entry,
                version,
                StorageVersionStatus.QUARANTINED.value,
                "Stored content failed integrity validation.",
            )
            raise VaultError(409, "The stored file failed integrity validation.")
        return VaultDownload(
            name=entry.name,
            mime_type=version.mime_type,
            size=version.size_bytes,
            stream=self.blobs.chunks(version.storage_key),
        )

    async def update_entry(
        self,
        session: AsyncSession,
        entry_id: str,
        *,
        name: str | None,
        parent_id: str | object | None = UNSET,
    ) -> dict[str, Any]:
        entry = await self._entry(session, entry_id)
        await self._workspace(session, entry.workspace_id, write=True)
        if entry.trashed_at is not None:
            raise VaultError(409, "Restore this item before renaming or moving it.")
        safe_name = self._safe_name(name) if name is not None else entry.name
        if name is not None and entry.kind == StorageEntryKind.FILE.value:
            extension = Path(safe_name).suffix.casefold()
            if extension not in self.settings.storage_allowed_extensions:
                raise VaultError(
                    415, f"Files with the {extension or '(none)'} extension are not allowed."
                )
        target_parent_id = entry.parent_id if parent_id is UNSET else parent_id
        parent = await self._parent(session, entry.workspace_id, target_parent_id)
        rows = list(
            await session.scalars(
                select(StorageEntry).where(StorageEntry.workspace_id == entry.workspace_id)
            )
        )
        old_prefix = f"{entry.path}/"
        subtree = [row for row in rows if row.id == entry.id or row.path.startswith(old_prefix)]
        subtree_ids = {row.id for row in subtree}
        if target_parent_id in subtree_ids:
            raise VaultError(409, "A folder cannot be moved inside itself.")
        new_root = self._child_path(parent, safe_name)
        proposed: dict[str, str] = {}
        try:
            for row in subtree:
                suffix = "" if row.id == entry.id else row.path[len(entry.path) :]
                candidate = logical_path(f"{new_root}{suffix}")
                proposed[row.id] = candidate
        except StorageNameError as error:
            raise VaultError(422, str(error)) from error
        occupied = {row.path_key for row in rows if row.id not in subtree_ids}
        if any(logical_path_key(path) in occupied for path in proposed.values()):
            raise VaultError(409, "The destination already contains an item with that path.")
        entry.name = safe_name
        entry.parent_id = target_parent_id
        for row in subtree:
            row.path = proposed[row.id]
            row.path_key = logical_path_key(row.path)
        session.add(
            self._event(
                entry.workspace_id,
                entry,
                "entry_updated",
                f"Updated {safe_name}.",
            )
        )
        await self._commit_conflict(session, "The destination already contains that name.")
        await session.refresh(entry)
        return await self.entry_view(session, entry)

    async def trash(self, session: AsyncSession, entry_id: str) -> dict[str, Any]:
        entry = await self._entry(session, entry_id)
        await self._workspace(session, entry.workspace_id, write=True)
        if entry.trashed_at is not None:
            raise VaultError(409, "This item is already in Trash.")
        affected = await self._subtree(session, entry)
        now = datetime.now(UTC)
        for row in affected:
            row.trashed_at = now
            row.trashed_by_kind = "owner"
            row.trashed_by_name = "Owner"
        session.add(
            self._event(entry.workspace_id, entry, "entry_trashed", f"Moved {entry.name} to Trash.")
        )
        await session.commit()
        await session.refresh(entry)
        return await self.entry_view(session, entry)

    async def restore(self, session: AsyncSession, entry_id: str) -> dict[str, Any]:
        entry = await self._entry(session, entry_id)
        await self._workspace(session, entry.workspace_id, write=True)
        if entry.trashed_at is None:
            raise VaultError(409, "This item is not in Trash.")
        if entry.parent_id:
            parent = await self._entry(session, entry.parent_id)
            if parent.trashed_at is not None:
                raise VaultError(409, "Restore the parent folder first.")
        for row in await self._subtree(session, entry):
            row.trashed_at = None
            row.trashed_by_kind = None
            row.trashed_by_employee_id = None
            row.trashed_by_name = None
        session.add(
            self._event(entry.workspace_id, entry, "entry_restored", f"Restored {entry.name}.")
        )
        await session.commit()
        await session.refresh(entry)
        return await self.entry_view(session, entry)

    async def reconcile(self, session: AsyncSession) -> dict[str, int]:
        versions = list(await session.scalars(select(StorageVersion)))
        entries = {row.id: row for row in await session.scalars(select(StorageEntry))}
        missing = corrupt = recovered = 0
        expected = {version.storage_key for version in versions}
        for version in versions:
            status = StorageVersionStatus.AVAILABLE.value
            try:
                size, digest = await self.blobs.checksum(version.storage_key)
                if size != version.size_bytes or digest != version.sha256:
                    status = StorageVersionStatus.QUARANTINED.value
                    corrupt += 1
            except BlobMissingError:
                status = StorageVersionStatus.MISSING.value
                missing += 1
            except BlobUnsafeError:
                status = StorageVersionStatus.QUARANTINED.value
                corrupt += 1
            if version.status != status and status == StorageVersionStatus.AVAILABLE.value:
                recovered += 1
            version.status = status
            entry = entries.get(version.entry_id)
            if entry and entry.current_version_number == version.number:
                entry.status = status
                entry.last_error = (
                    None
                    if status == StorageVersionStatus.AVAILABLE.value
                    else (
                        "Stored content is missing."
                        if status == StorageVersionStatus.MISSING.value
                        else "Stored content failed integrity validation."
                    )
                )
        actual, unsafe = await self.blobs.inventory()
        orphaned = len(actual - expected)
        session.add(
            StorageEvent(
                level="warn" if missing or corrupt or orphaned or unsafe else "info",
                kind="storage_reconciled",
                actor_kind="system",
                actor_name="NEXUS storage service",
                text="Validated stored file metadata against local blobs.",
                details={
                    "checked": len(versions),
                    "missing": missing,
                    "corrupt": corrupt,
                    "recovered": recovered,
                    "orphaned": orphaned,
                    "unsafe": unsafe,
                },
            )
        )
        await session.commit()
        return {
            "checked": len(versions),
            "missing": missing,
            "corrupt": corrupt,
            "recovered": recovered,
            "orphaned": orphaned,
            "unsafe": unsafe,
        }

    async def entry_view(self, session: AsyncSession, entry: StorageEntry) -> dict[str, Any]:
        version = await self._current_version(session, entry)
        return {
            "id": entry.id,
            "workspace_id": entry.workspace_id,
            "parent_id": entry.parent_id,
            "kind": entry.kind,
            "name": entry.name,
            "path": entry.path,
            "description": entry.description,
            "status": entry.status,
            "current_version_number": entry.current_version_number,
            "size_bytes": version.size_bytes if version else None,
            "mime_type": version.mime_type if version else None,
            "sha256": version.sha256 if version else None,
            "trashed_at": entry.trashed_at,
            "created_at": entry.created_at,
            "updated_at": entry.updated_at,
        }

    async def _workspace(
        self, session: AsyncSession, workspace_id: str, *, write: bool = False
    ) -> StorageWorkspace:
        statement = select(StorageWorkspace).where(StorageWorkspace.id == workspace_id)
        if write:
            statement = statement.with_for_update()
        workspace = await session.scalar(statement)
        if workspace is None:
            raise VaultError(404, "Storage workspace not found.")
        if write and workspace.state == StorageWorkspaceState.READ_ONLY.value:
            raise VaultError(409, "This storage workspace is read-only.")
        return workspace

    async def _entry(self, session: AsyncSession, entry_id: str) -> StorageEntry:
        entry = await session.get(StorageEntry, entry_id)
        if entry is None:
            raise VaultError(404, "Storage item not found.")
        return entry

    async def _parent(
        self, session: AsyncSession, workspace_id: str, parent_id: str | object | None
    ) -> StorageEntry | None:
        if parent_id is None or parent_id is UNSET:
            return None
        parent = await self._entry(session, str(parent_id))
        if (
            parent.workspace_id != workspace_id
            or parent.kind != StorageEntryKind.FOLDER.value
            or parent.trashed_at is not None
        ):
            raise VaultError(404, "Destination folder not found.")
        return parent

    async def _current_version(
        self, session: AsyncSession, entry: StorageEntry
    ) -> StorageVersion | None:
        if entry.current_version_number == 0:
            return None
        return await session.scalar(
            select(StorageVersion).where(
                StorageVersion.entry_id == entry.id,
                StorageVersion.number == entry.current_version_number,
            )
        )

    async def _usage(self, session: AsyncSession, workspace_id: str) -> int:
        value = await session.scalar(
            select(func.coalesce(func.sum(StorageVersion.size_bytes), 0))
            .join(StorageEntry, StorageEntry.id == StorageVersion.entry_id)
            .where(
                StorageEntry.workspace_id == workspace_id,
                StorageVersion.status.in_(
                    [
                        StorageVersionStatus.AVAILABLE.value,
                        StorageVersionStatus.QUARANTINED.value,
                    ]
                ),
            )
        )
        return int(value or 0)

    async def _owner(
        self, session: AsyncSession, workspace: StorageWorkspace
    ) -> tuple[str, str, str]:
        if workspace.scope == StorageWorkspaceScope.COMPANY.value:
            return "company", "company", "NEXUS AI"
        department = await session.get(Department, workspace.department_key or "")
        if department is None:
            raise VaultError(409, "The workspace department no longer exists.")
        return "department", department.key, department.name

    async def _ensure_available_path(
        self, session: AsyncSession, workspace_id: str, path: str
    ) -> None:
        existing = await session.scalar(
            select(StorageEntry.id).where(
                StorageEntry.workspace_id == workspace_id,
                StorageEntry.path_key == logical_path_key(path),
            )
        )
        if existing:
            raise VaultError(409, "A file or folder with that name already exists.")

    async def _subtree(self, session: AsyncSession, entry: StorageEntry) -> list[StorageEntry]:
        prefix = f"{entry.path}/"
        rows = list(
            await session.scalars(
                select(StorageEntry).where(StorageEntry.workspace_id == entry.workspace_id)
            )
        )
        return [row for row in rows if row.id == entry.id or row.path.startswith(prefix)]

    async def _commit_conflict(self, session: AsyncSession, detail: str) -> None:
        try:
            await session.commit()
        except IntegrityError as error:
            await session.rollback()
            raise VaultError(409, detail) from error

    async def _mark_unavailable(
        self,
        session: AsyncSession,
        entry: StorageEntry,
        version: StorageVersion,
        status: str,
        error: str,
    ) -> None:
        version.status = status
        entry.status = status
        entry.last_error = error
        session.add(
            self._event(
                entry.workspace_id,
                entry,
                "file_validation_failed",
                f"Validation failed for {entry.name}.",
                version=version,
            )
        )
        await session.commit()

    def _quota(self, workspace: StorageWorkspace) -> int:
        return (
            workspace.quota_bytes
            if workspace.quota_bytes is not None
            else self.settings.storage_department_quota_bytes
        )

    @staticmethod
    def _safe_name(value: str | None) -> str:
        if value is None:
            raise VaultError(422, "A name is required.")
        try:
            return logical_name(value)
        except StorageNameError as error:
            raise VaultError(422, str(error)) from error

    @staticmethod
    def _child_path(parent: StorageEntry | None, name: str) -> str:
        try:
            return logical_path(f"{parent.path}/{name}" if parent else name)
        except StorageNameError as error:
            raise VaultError(422, str(error)) from error

    @staticmethod
    def _mime(filename: str, supplied: str | None) -> str:
        if supplied and MIME_PATTERN.fullmatch(supplied):
            return supplied.lower()
        guessed, _ = mimetypes.guess_type(filename)
        return guessed or "application/octet-stream"

    @staticmethod
    def _id(prefix: str) -> str:
        return f"{prefix}_{uuid4().hex[:24]}"

    @staticmethod
    def _event(
        workspace_id: str,
        entry: StorageEntry,
        kind: str,
        text: str,
        *,
        version: StorageVersion | None = None,
        details: dict[str, object] | None = None,
    ) -> StorageEvent:
        return StorageEvent(
            workspace_id=workspace_id,
            entry_id=entry.id,
            version_id=version.id if version else None,
            level="info",
            kind=kind,
            actor_kind="owner",
            actor_name="Owner",
            text=text,
            details=details or {},
        )
