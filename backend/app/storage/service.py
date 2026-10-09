"""Transactional Digital Vault operations over metadata and immutable blobs."""

from __future__ import annotations

import asyncio
import mimetypes
import re
import tempfile
import zipfile
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from sqlalchemy import delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.models import (
    App,
    AppFile,
    AppVersion,
    CodeRun,
    Conversation,
    Department,
    Employee,
    Message,
    StorageEntry,
    StorageEntryKind,
    StorageEntryStatus,
    StorageEvent,
    StorageGrant,
    StorageGranteeKind,
    StorageLink,
    StorageTag,
    StorageVersion,
    StorageVersionStatus,
    StorageWorkspace,
    StorageWorkspaceScope,
    StorageWorkspaceState,
    Task,
    Workflow,
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


@dataclass(frozen=True)
class VaultArchive:
    name: str
    size: int
    stream: AsyncIterator[bytes]


@dataclass(frozen=True)
class StorageActor:
    """Trusted internal identity used by storage policy checks."""

    kind: str
    name: str
    employee_id: str | None = None
    department_key: str | None = None


OWNER_ACTOR = StorageActor(kind="owner", name="Owner")
SYSTEM_ACTOR = StorageActor(kind="system", name="NEXUS storage service")
PERMISSION_RANK = {"read": 1, "write": 2, "manage": 3}


class VaultService:
    """The only layer allowed to coordinate storage metadata and blob bytes."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.blobs = LocalBlobStore(settings.storage_root)

    async def initialize(self) -> None:
        await self.blobs.initialize()

    async def sync_workspaces(self, session: AsyncSession) -> int:
        """Idempotently provision the company workspace and every live department."""
        existing = set(await session.scalars(select(StorageWorkspace.id)))
        wanted: list[StorageWorkspace] = []
        if "ws_company" not in existing:
            wanted.append(
                StorageWorkspace(
                    id="ws_company",
                    scope=StorageWorkspaceScope.COMPANY.value,
                    state=StorageWorkspaceState.ACTIVE.value,
                )
            )
        for department_key in await session.scalars(select(Department.key)):
            workspace_id = f"ws_department:{department_key}"
            if workspace_id not in existing:
                wanted.append(
                    StorageWorkspace(
                        id=workspace_id,
                        scope=StorageWorkspaceScope.DEPARTMENT.value,
                        department_key=department_key,
                        state=StorageWorkspaceState.ACTIVE.value,
                    )
                )
        if wanted:
            session.add_all(wanted)
            await self._commit_conflict(session, "Storage workspaces changed concurrently.")
        return len(wanted)

    async def actor_for_employee(self, session: AsyncSession, employee_id: str) -> StorageActor:
        employee = await session.get(Employee, employee_id)
        if employee is None:
            raise VaultError(404, "Storage actor not found.")
        return StorageActor(
            kind="employee",
            name=employee.name,
            employee_id=employee.id,
            department_key=employee.department,
        )

    async def workspaces(
        self, session: AsyncSession, *, actor: StorageActor = OWNER_ACTOR
    ) -> list[dict[str, Any]]:
        await self.sync_workspaces(session)
        rows = list(await session.scalars(select(StorageWorkspace).order_by(StorageWorkspace.id)))
        result: list[dict[str, Any]] = []
        for workspace in rows:
            if not await self._allowed(session, actor, workspace, "read"):
                continue
            used = await self._usage(session, workspace.id)
            result.append(
                {
                    "id": workspace.id,
                    "scope": workspace.scope,
                    "department_key": workspace.department_key,
                    "state": workspace.state,
                    "used_bytes": used,
                    "quota_bytes": self._quota(workspace),
                    "quota_override_bytes": workspace.quota_bytes,
                }
            )
        return result

    async def update_workspace(
        self,
        session: AsyncSession,
        workspace_id: str,
        *,
        quota_bytes: int | object | None = UNSET,
        state: str | None = None,
        actor: StorageActor = OWNER_ACTOR,
    ) -> dict[str, Any]:
        workspace = await self._workspace(session, workspace_id)
        await self._require(session, actor, workspace, "manage")
        if quota_bytes is not UNSET:
            assert quota_bytes is None or isinstance(quota_bytes, int)
            if quota_bytes is not None and quota_bytes < await self._usage(session, workspace_id):
                raise VaultError(409, "The quota cannot be lower than current storage usage.")
            workspace.quota_bytes = quota_bytes
        if state is not None:
            if state not in {
                StorageWorkspaceState.ACTIVE.value,
                StorageWorkspaceState.READ_ONLY.value,
            }:
                raise VaultError(422, "Unknown storage workspace state.")
            workspace.state = state
        session.add(
            self._workspace_event(
                workspace_id,
                "workspace_updated",
                "Updated workspace quota or state.",
                actor,
                {"quota_bytes": workspace.quota_bytes, "state": workspace.state},
            )
        )
        await session.commit()
        return await self._workspace_view(session, workspace)

    async def grants(
        self,
        session: AsyncSession,
        workspace_id: str,
        *,
        actor: StorageActor = OWNER_ACTOR,
    ) -> list[dict[str, Any]]:
        workspace = await self._workspace(session, workspace_id)
        await self._require(session, actor, workspace, "manage")
        rows = await session.scalars(
            select(StorageGrant)
            .where(StorageGrant.workspace_id == workspace_id)
            .order_by(StorageGrant.created_at, StorageGrant.id)
        )
        return [self._grant_view(row) for row in rows]

    async def grant_access(
        self,
        session: AsyncSession,
        workspace_id: str,
        *,
        grantee_kind: str,
        grantee_id: str,
        permission: str,
        entry_id: str | None = None,
        expires_at: datetime | None = None,
        actor: StorageActor = OWNER_ACTOR,
    ) -> dict[str, Any]:
        workspace = await self._workspace(session, workspace_id)
        await self._require(session, actor, workspace, "manage")
        if grantee_kind not in {
            StorageGranteeKind.EMPLOYEE.value,
            StorageGranteeKind.DEPARTMENT.value,
        }:
            raise VaultError(422, "Unknown storage grantee kind.")
        if permission not in PERMISSION_RANK:
            raise VaultError(422, "Unknown storage permission.")
        if entry_id:
            entry = await self._entry(session, entry_id)
            if entry.workspace_id != workspace_id:
                raise VaultError(422, "The grant item must belong to this workspace.")
        if grantee_kind == StorageGranteeKind.EMPLOYEE.value:
            if await session.get(Employee, grantee_id) is None:
                raise VaultError(422, "The grantee employee does not exist.")
        elif await session.get(Department, grantee_id) is None:
            raise VaultError(422, "The grantee department does not exist.")
        if expires_at is not None:
            if expires_at.tzinfo is None or expires_at.utcoffset() is None:
                raise VaultError(422, "Grant expiry must include a timezone.")
            if expires_at <= datetime.now(UTC):
                raise VaultError(422, "Grant expiry must be in the future.")
        duplicate = await session.scalar(
            select(StorageGrant).where(
                StorageGrant.workspace_id == workspace_id,
                StorageGrant.entry_id == entry_id,
                StorageGrant.grantee_kind == grantee_kind,
                StorageGrant.grantee_id == grantee_id,
                StorageGrant.permission == permission,
                StorageGrant.revoked_at.is_(None),
            )
        )
        if duplicate and (duplicate.expires_at is None or duplicate.expires_at > datetime.now(UTC)):
            return self._grant_view(duplicate)
        grant = StorageGrant(
            id=self._id("stg"),
            workspace_id=workspace_id,
            entry_id=entry_id,
            grantee_kind=grantee_kind,
            grantee_id=grantee_id,
            permission=permission,
            granted_by_kind=actor.kind,
            granted_by_employee_id=actor.employee_id,
            granted_by_name=actor.name,
            expires_at=expires_at,
        )
        session.add(grant)
        session.add(
            self._workspace_event(
                workspace_id,
                "access_granted",
                f"Granted {permission} access to {grantee_kind} {grantee_id}.",
                actor,
                {"grant_id": grant.id, "entry_id": entry_id},
            )
        )
        await session.commit()
        await session.refresh(grant)
        return self._grant_view(grant)

    async def revoke_grant(
        self,
        session: AsyncSession,
        grant_id: str,
        *,
        actor: StorageActor = OWNER_ACTOR,
    ) -> dict[str, Any]:
        grant = await session.get(StorageGrant, grant_id)
        if grant is None:
            raise VaultError(404, "Storage grant not found.")
        workspace = await self._workspace(session, grant.workspace_id)
        await self._require(session, actor, workspace, "manage")
        if grant.revoked_at is None:
            grant.revoked_at = datetime.now(UTC)
            grant.revoked_by_kind = actor.kind
            grant.revoked_by_employee_id = actor.employee_id
            grant.revoked_by_name = actor.name
            session.add(
                self._workspace_event(
                    grant.workspace_id,
                    "access_revoked",
                    f"Revoked storage grant {grant.id}.",
                    actor,
                    {"grant_id": grant.id},
                )
            )
            await session.commit()
        return self._grant_view(grant)

    async def links(
        self,
        session: AsyncSession,
        entry_id: str,
        *,
        actor: StorageActor = OWNER_ACTOR,
    ) -> list[dict[str, Any]]:
        entry = await self._entry(session, entry_id)
        workspace = await self._workspace(session, entry.workspace_id)
        await self._require(session, actor, workspace, "read", entry)
        rows = await session.scalars(
            select(StorageLink)
            .where(StorageLink.entry_id == entry_id)
            .order_by(StorageLink.created_at, StorageLink.id)
        )
        return [self._link_view(row) for row in rows]

    async def link_entry(
        self,
        session: AsyncSession,
        entry_id: str,
        *,
        target_type: str,
        target_id: str,
        relation: str,
        label: str | None,
        actor: StorageActor = OWNER_ACTOR,
    ) -> dict[str, Any]:
        entry = await self._entry(session, entry_id)
        workspace = await self._workspace(session, entry.workspace_id, write=True)
        await self._require(session, actor, workspace, "write", entry)
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", relation):
            raise VaultError(422, "The artifact link relation is invalid.")
        await self._validate_link_target(session, workspace, target_type, target_id)
        version = await self._current_version(session, entry)
        version_id = version.id if version else None
        idempotency_key = ":".join(
            [entry.id, version_id or "entry", target_type, target_id, relation]
        )
        existing = await session.scalar(
            select(StorageLink).where(StorageLink.idempotency_key == idempotency_key)
        )
        if existing:
            return self._link_view(existing)
        link = StorageLink(
            id=self._id("stl"),
            entry_id=entry.id,
            version_id=version_id,
            target_type=target_type,
            target_id=target_id,
            relation=relation,
            label=label.strip() if label and label.strip() else None,
            idempotency_key=idempotency_key,
        )
        session.add(link)
        session.add(
            self._event(
                entry.workspace_id,
                entry,
                "artifact_linked",
                f"Linked {entry.name} to {target_type} {target_id}.",
                actor=actor,
                version=version,
                details={"link_id": link.id, "target_type": target_type, "target_id": target_id},
            )
        )
        await self._commit_conflict(session, "This artifact link already exists.")
        await session.refresh(link)
        return self._link_view(link)

    async def search(
        self,
        session: AsyncSession,
        *,
        workspace_id: str | None,
        query: str | None,
        kind: str | None,
        tag: str | None,
        trashed: bool,
        sort: str,
        descending: bool,
        offset: int,
        limit: int,
        actor: StorageActor = OWNER_ACTOR,
    ) -> dict[str, Any]:
        """Search safe metadata with bounded, incremental results."""
        await self.sync_workspaces(session)
        workspace_ids = {item["id"] for item in await self.workspaces(session, actor=actor)}
        if workspace_id:
            if workspace_id not in workspace_ids:
                raise VaultError(404, "Storage workspace not found.")
            workspace_ids = {workspace_id}
        conditions: list[Any] = [StorageEntry.workspace_id.in_(workspace_ids)]
        conditions.append(
            StorageEntry.trashed_at.is_not(None) if trashed else StorageEntry.trashed_at.is_(None)
        )
        if kind:
            conditions.append(StorageEntry.kind == kind)
        if tag:
            conditions.append(
                StorageEntry.id.in_(
                    select(StorageTag.entry_id).where(StorageTag.tag_key == tag.casefold())
                )
            )
        needle = (query or "").strip().casefold()
        if needle:
            pattern = f"%{self._like(needle)}%"
            conditions.append(
                or_(
                    func.lower(StorageEntry.name).like(pattern, escape="\\"),
                    func.lower(StorageEntry.path).like(pattern, escape="\\"),
                    func.lower(func.coalesce(StorageEntry.description, "")).like(
                        pattern, escape="\\"
                    ),
                    func.lower(StorageEntry.owner_name).like(pattern, escape="\\"),
                    func.lower(func.coalesce(StorageEntry.created_by_name, "")).like(
                        pattern, escape="\\"
                    ),
                    func.lower(StorageEntry.workspace_id).like(pattern, escape="\\"),
                    StorageEntry.id.in_(
                        select(StorageVersion.entry_id).where(
                            func.lower(StorageVersion.mime_type).like(pattern, escape="\\")
                        )
                    ),
                    StorageEntry.id.in_(
                        select(StorageTag.entry_id).where(
                            func.lower(StorageTag.tag).like(pattern, escape="\\")
                        )
                    ),
                    StorageEntry.id.in_(
                        select(StorageLink.entry_id).where(
                            or_(
                                func.lower(StorageLink.target_id).like(pattern, escape="\\"),
                                func.lower(func.coalesce(StorageLink.label, "")).like(
                                    pattern, escape="\\"
                                ),
                            )
                        )
                    ),
                )
            )
        order_columns = {
            "name": StorageEntry.name,
            "created": StorageEntry.created_at,
            "updated": StorageEntry.updated_at,
            "type": StorageEntry.kind,
        }
        order_column = order_columns.get(sort, StorageEntry.updated_at)
        order = order_column.desc() if descending else order_column.asc()
        total = int(
            await session.scalar(select(func.count()).select_from(StorageEntry).where(*conditions))
            or 0
        )
        rows = list(
            await session.scalars(
                select(StorageEntry)
                .where(*conditions)
                .order_by(order, StorageEntry.id)
                .offset(offset)
                .limit(limit)
            )
        )
        return {
            "items": [await self.entry_view(session, row) for row in rows],
            "total": total,
            "offset": offset,
            "limit": limit,
        }

    async def record_artifact_failure(
        self,
        session: AsyncSession,
        workspace_id: str,
        *,
        source_type: str,
        source_id: str,
        message: str,
        actor: StorageActor = SYSTEM_ACTOR,
    ) -> None:
        """Record a truthful registration failure without inventing a file entry."""
        workspace = await self._workspace(session, workspace_id, write=True)
        await self._require(session, actor, workspace, "write")
        session.add(
            self._workspace_event(
                workspace_id,
                "artifact_registration_failed",
                message,
                actor,
                {"source_type": source_type, "source_id": source_id},
                level="error",
            )
        )
        await session.commit()

    async def entry_detail(
        self,
        session: AsyncSession,
        entry_id: str,
        *,
        actor: StorageActor = OWNER_ACTOR,
    ) -> dict[str, Any]:
        entry = await self._entry(session, entry_id)
        workspace = await self._workspace(session, entry.workspace_id)
        await self._require(session, actor, workspace, "read", entry)
        result = await self.entry_view(session, entry)
        tags = list(
            await session.scalars(
                select(StorageTag).where(StorageTag.entry_id == entry.id).order_by(StorageTag.tag)
            )
        )
        versions = list(
            await session.scalars(
                select(StorageVersion)
                .where(StorageVersion.entry_id == entry.id)
                .order_by(StorageVersion.number.desc())
            )
        )
        links = list(
            await session.scalars(
                select(StorageLink)
                .where(StorageLink.entry_id == entry.id)
                .order_by(StorageLink.created_at.desc())
            )
        )
        events = list(
            await session.scalars(
                select(StorageEvent)
                .where(StorageEvent.entry_id == entry.id)
                .order_by(StorageEvent.created_at.desc(), StorageEvent.id.desc())
                .limit(50)
            )
        )
        result.update(
            {
                "original_name": entry.original_name,
                "artifact_type": entry.artifact_type,
                "visibility": entry.visibility,
                "created_by_kind": entry.created_by_kind,
                "created_by_employee_id": entry.created_by_employee_id,
                "created_by_name": entry.created_by_name,
                "owner_kind": entry.owner_kind,
                "owner_id": entry.owner_id,
                "owner_name": entry.owner_name,
                "tags": [tag.tag for tag in tags],
                "favorite": any(tag.tag_key == "favorite" for tag in tags),
                "preview_kind": self._preview_kind(entry, versions[0] if versions else None),
                "versions": [
                    {
                        "id": version.id,
                        "number": version.number,
                        "mime_type": version.mime_type,
                        "size_bytes": version.size_bytes,
                        "sha256": version.sha256,
                        "status": version.status,
                        "created_by_name": version.created_by_name,
                        "created_at": version.created_at,
                    }
                    for version in versions
                ],
                "links": [self._link_view(link) for link in links],
                "events": [
                    {
                        "id": event.id,
                        "kind": event.kind,
                        "level": event.level,
                        "actor_name": event.actor_name,
                        "text": event.text,
                        "created_at": event.created_at,
                    }
                    for event in events
                ],
            }
        )
        return result

    async def duplicate(
        self,
        session: AsyncSession,
        entry_id: str,
        *,
        destination_workspace_id: str | None,
        destination_parent_id: str | None,
        name: str | None,
        actor: StorageActor = OWNER_ACTOR,
    ) -> dict[str, Any]:
        source = await self._entry(session, entry_id)
        source_workspace = await self._workspace(session, source.workspace_id)
        await self._require(session, actor, source_workspace, "read", source)
        if source.trashed_at is not None:
            raise VaultError(409, "Restore this item before copying it.")
        workspace_id = destination_workspace_id or source.workspace_id
        destination_workspace = await self._workspace(session, workspace_id, write=True)
        parent = await self._parent(session, workspace_id, destination_parent_id)
        await self._require(session, actor, destination_workspace, "write", parent)
        safe_name = (
            self._safe_name(name)
            if name
            else await self._copy_name(session, workspace_id, parent, source.name)
        )
        root_path = self._child_path(parent, safe_name)
        await self._ensure_available_path(session, workspace_id, root_path)
        source_rows = sorted(
            await self._subtree(session, source), key=lambda row: row.path.count("/")
        )
        if len(source_rows) > 5000:
            raise VaultError(413, "This folder is too large to copy in one operation.")
        source_versions: dict[str, StorageVersion] = {}
        total_bytes = 0
        for row in source_rows:
            if row.trashed_at is not None:
                raise VaultError(409, "Restore this folder before copying it.")
            version = await self._current_version(session, row)
            if version:
                if version.status != StorageVersionStatus.AVAILABLE.value:
                    raise VaultError(409, f"{row.name} is not available to copy.")
                source_versions[row.id] = version
                total_bytes += version.size_bytes
        if total_bytes > self._quota(destination_workspace) - await self._usage(
            session, workspace_id
        ):
            raise VaultError(413, "The copy would exceed the destination workspace quota.")
        owner_kind, owner_id, owner_name = await self._owner(session, destination_workspace)
        id_map: dict[str, str] = {}
        created_blobs: list[str] = []
        root_new: StorageEntry | None = None
        try:
            for row in source_rows:
                new_id = self._id("ste")
                id_map[row.id] = new_id
                suffix = "" if row.id == source.id else row.path[len(source.path) :]
                new_path = logical_path(f"{root_path}{suffix}")
                copied = StorageEntry(
                    id=new_id,
                    workspace_id=workspace_id,
                    parent_id=(
                        destination_parent_id
                        if row.id == source.id
                        else id_map.get(row.parent_id or "")
                    ),
                    kind=row.kind,
                    path=new_path,
                    path_key=logical_path_key(new_path),
                    name=safe_name if row.id == source.id else row.name,
                    original_name=row.original_name,
                    description=row.description,
                    artifact_type=row.artifact_type,
                    visibility=(
                        "company"
                        if destination_workspace.scope == StorageWorkspaceScope.COMPANY.value
                        else "department"
                    ),
                    status=row.status,
                    current_version_number=1 if row.id in source_versions else 0,
                    created_by_kind=actor.kind,
                    created_by_employee_id=actor.employee_id,
                    created_by_name=actor.name,
                    owner_kind=owner_kind,
                    owner_id=owner_id,
                    owner_name=owner_name,
                )
                session.add(copied)
                await session.flush()
                if root_new is None:
                    root_new = copied
                version = source_versions.get(row.id)
                if version:
                    blob = await self.blobs.clone(version.storage_key, version.size_bytes)
                    created_blobs.append(blob.key)
                    session.add(
                        StorageVersion(
                            id=self._id("stv"),
                            entry_id=copied.id,
                            number=1,
                            backend=self.settings.storage_backend.value,
                            storage_key=blob.key,
                            original_name=copied.name,
                            mime_type=version.mime_type,
                            size_bytes=blob.size,
                            sha256=blob.sha256,
                            status=StorageVersionStatus.AVAILABLE.value,
                            change_description=f"Copied from {source.path}",
                            created_by_kind=actor.kind,
                            created_by_employee_id=actor.employee_id,
                            created_by_name=actor.name,
                        )
                    )
                for tag in await session.scalars(
                    select(StorageTag).where(StorageTag.entry_id == row.id)
                ):
                    session.add(StorageTag(entry_id=copied.id, tag_key=tag.tag_key, tag=tag.tag))
            assert root_new is not None
            session.add(
                self._event(
                    workspace_id,
                    root_new,
                    "entry_copied",
                    f"Copied {source.name} to {root_new.path}.",
                    actor=actor,
                    details={"source_entry_id": source.id, "items": len(source_rows)},
                )
            )
            await self._commit_conflict(session, "The destination already contains this copy.")
        except BaseException:
            await session.rollback()
            for key in created_blobs:
                await self.blobs.remove(key)
            raise
        await session.refresh(root_new)
        return await self.entry_view(session, root_new)

    async def export_zip(
        self,
        session: AsyncSession,
        entry_ids: list[str],
        *,
        actor: StorageActor = OWNER_ACTOR,
    ) -> VaultArchive:
        if not entry_ids or len(entry_ids) > 100:
            raise VaultError(422, "Select between 1 and 100 items to export.")
        selected: list[StorageEntry] = []
        included: dict[str, StorageEntry] = {}
        for entry_id in dict.fromkeys(entry_ids):
            entry = await self._entry(session, entry_id)
            workspace = await self._workspace(session, entry.workspace_id)
            await self._require(session, actor, workspace, "read", entry)
            if entry.trashed_at is not None:
                raise VaultError(409, "Restore items before exporting them.")
            selected.append(entry)
            for row in await self._subtree(session, entry):
                if row.trashed_at is None:
                    included[row.id] = row
        if len(included) > 5000:
            raise VaultError(413, "This export contains too many items.")
        # The response iterator owns and closes this handle after streaming completes.
        handle = tempfile.SpooledTemporaryFile(  # noqa: SIM115
            max_size=8 * 1024 * 1024, mode="w+b"
        )
        try:
            with zipfile.ZipFile(handle, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
                for entry in sorted(included.values(), key=lambda row: row.path):
                    workspace_prefix = (
                        "company"
                        if entry.workspace_id == "ws_company"
                        else entry.workspace_id.replace("ws_department:", "")
                    )
                    archive_name = f"{workspace_prefix}/{entry.path}"
                    if entry.kind == StorageEntryKind.FOLDER.value:
                        archive.writestr(f"{archive_name}/", b"")
                        continue
                    download = await self.download(session, entry.id, actor=actor)
                    with archive.open(archive_name, "w") as destination:
                        async for chunk in download.stream:
                            destination.write(chunk)
            size = handle.tell()
            handle.seek(0)
        except BaseException:
            handle.close()
            raise

        async def chunks() -> AsyncIterator[bytes]:
            try:
                while chunk := await asyncio.to_thread(handle.read, 1024 * 1024):
                    yield chunk
            finally:
                handle.close()

        name = f"{selected[0].name}.zip" if len(selected) == 1 else "nexus-vault-export.zip"
        return VaultArchive(name=name, size=size, stream=chunks())

    async def permanent_delete(
        self,
        session: AsyncSession,
        entry_id: str,
        *,
        actor: StorageActor = OWNER_ACTOR,
    ) -> dict[str, int]:
        entry = await self._entry(session, entry_id)
        workspace = await self._workspace(session, entry.workspace_id, write=True)
        await self._require(session, actor, workspace, "manage", entry)
        if entry.trashed_at is None:
            raise VaultError(409, "Move this item to Trash before permanently deleting it.")
        rows = await self._subtree(session, entry)
        versions = list(
            await session.scalars(
                select(StorageVersion).where(StorageVersion.entry_id.in_([row.id for row in rows]))
            )
        )
        session.add(
            self._workspace_event(
                entry.workspace_id,
                "entry_permanently_deleted",
                f"Permanently deleted {entry.name} and {len(rows) - 1} descendants.",
                actor,
                {"items": len(rows), "versions": len(versions)},
            )
        )
        for row in sorted(rows, key=lambda item: item.path.count("/"), reverse=True):
            await session.execute(delete(StorageEntry).where(StorageEntry.id == row.id))
        await session.commit()
        removed = 0
        for version in versions:
            try:
                await self.blobs.remove(version.storage_key)
                removed += 1
            except BlobUnsafeError:
                pass
        return {"items": len(rows), "versions": len(versions), "blobs_removed": removed}

    async def entries(
        self,
        session: AsyncSession,
        workspace_id: str,
        parent_id: str | None,
        *,
        trashed: bool,
        actor: StorageActor = OWNER_ACTOR,
    ) -> list[dict[str, Any]]:
        workspace = await self._workspace(session, workspace_id)
        parent: StorageEntry | None = None
        if parent_id is not None:
            parent = await self._entry(session, parent_id)
            if parent.workspace_id != workspace_id or parent.kind != StorageEntryKind.FOLDER.value:
                raise VaultError(404, "Folder not found.")
        await self._require(session, actor, workspace, "read", parent)
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
        *,
        actor: StorageActor = OWNER_ACTOR,
    ) -> dict[str, Any]:
        workspace = await self._workspace(session, workspace_id, write=True)
        safe_name = self._safe_name(name)
        parent = await self._parent(session, workspace_id, parent_id)
        await self._require(session, actor, workspace, "write", parent)
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
            created_by_kind=actor.kind,
            created_by_employee_id=actor.employee_id,
            created_by_name=actor.name,
            owner_kind=owner_kind,
            owner_id=owner_id,
            owner_name=owner_name,
        )
        session.add(entry)
        session.add(
            self._event(
                workspace_id,
                entry,
                "folder_created",
                f"Created folder {safe_name}.",
                actor=actor,
            )
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
        *,
        actor: StorageActor = OWNER_ACTOR,
    ) -> dict[str, Any]:
        workspace = await self._workspace(session, workspace_id, write=True)
        safe_name = self._safe_name(filename)
        extension = Path(safe_name).suffix.casefold()
        if extension not in self.settings.storage_allowed_extensions:
            raise VaultError(
                415, f"Files with the {extension or '(none)'} extension are not allowed."
            )
        parent = await self._parent(session, workspace_id, parent_id)
        await self._require(session, actor, workspace, "write", parent)
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
            created_by_kind=actor.kind,
            created_by_employee_id=actor.employee_id,
            created_by_name=actor.name,
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
            created_by_kind=actor.kind,
            created_by_employee_id=actor.employee_id,
            created_by_name=actor.name,
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
                    actor=actor,
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

    async def download(
        self,
        session: AsyncSession,
        entry_id: str,
        *,
        actor: StorageActor = OWNER_ACTOR,
    ) -> VaultDownload:
        entry = await self._entry(session, entry_id)
        workspace = await self._workspace(session, entry.workspace_id)
        await self._require(session, actor, workspace, "read", entry)
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

    async def append_version(
        self,
        session: AsyncSession,
        entry_id: str,
        content_type: str | None,
        reader: Reader,
        change_description: str | None,
        *,
        actor: StorageActor = OWNER_ACTOR,
    ) -> dict[str, Any]:
        """Append immutable bytes to an existing file; identical content is idempotent."""
        entry = await self._entry(session, entry_id)
        workspace = await self._workspace(session, entry.workspace_id, write=True)
        await self._require(session, actor, workspace, "write", entry)
        if entry.kind != StorageEntryKind.FILE.value or entry.trashed_at is not None:
            raise VaultError(409, "Restore this file before adding a version.")
        extension = Path(entry.name).suffix.casefold()
        if extension not in self.settings.storage_allowed_extensions:
            raise VaultError(
                415, f"Files with the {extension or '(none)'} extension are not allowed."
            )
        try:
            blob = await self.blobs.put(reader, self.settings.storage_max_file_bytes)
        except BlobLimitError as error:
            raise VaultError(413, "The file exceeds the configured size limit.") from error
        except BlobUnsafeError as error:
            raise VaultError(503, str(error)) from error
        current = await self._current_version(session, entry)
        if current and current.sha256 == blob.sha256 and current.size_bytes == blob.size:
            await self.blobs.remove(blob.key)
            return await self.entry_view(session, entry)
        remaining = self._quota(workspace) - await self._usage(session, workspace.id)
        if blob.size > remaining:
            await self.blobs.remove(blob.key)
            raise VaultError(413, "The new version would exceed the workspace quota.")
        version = StorageVersion(
            id=self._id("stv"),
            entry_id=entry.id,
            number=entry.current_version_number + 1,
            backend=self.settings.storage_backend.value,
            storage_key=blob.key,
            original_name=entry.name,
            mime_type=self._mime(entry.name, content_type),
            size_bytes=blob.size,
            sha256=blob.sha256,
            status=StorageVersionStatus.AVAILABLE.value,
            change_description=(
                change_description.strip()
                if change_description and change_description.strip()
                else None
            ),
            created_by_kind=actor.kind,
            created_by_employee_id=actor.employee_id,
            created_by_name=actor.name,
        )
        entry.current_version_number = version.number
        entry.status = StorageEntryStatus.AVAILABLE.value
        entry.last_error = None
        try:
            session.add(version)
            await session.flush()
            session.add(
                self._event(
                    entry.workspace_id,
                    entry,
                    "version_created",
                    f"Added version {version.number} of {entry.name}.",
                    actor=actor,
                    version=version,
                    details={"size_bytes": blob.size},
                )
            )
            await self._commit_conflict(session, "This file changed concurrently.")
        except BaseException:
            await session.rollback()
            await self.blobs.remove(blob.key)
            raise
        await session.refresh(entry)
        return await self.entry_view(session, entry)

    async def update_entry(
        self,
        session: AsyncSession,
        entry_id: str,
        *,
        name: str | None,
        parent_id: str | object | None = UNSET,
        description: str | object | None = UNSET,
        artifact_type: str | object | None = UNSET,
        tags: list[str] | object = UNSET,
        actor: StorageActor = OWNER_ACTOR,
    ) -> dict[str, Any]:
        entry = await self._entry(session, entry_id)
        workspace = await self._workspace(session, entry.workspace_id, write=True)
        await self._require(session, actor, workspace, "write", entry)
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
        if target_parent_id != entry.parent_id:
            await self._require(session, actor, workspace, "write", parent)
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
        if description is not UNSET:
            assert description is None or isinstance(description, str)
            entry.description = description.strip() if description and description.strip() else None
        if artifact_type is not UNSET:
            assert artifact_type is None or isinstance(artifact_type, str)
            entry.artifact_type = (
                artifact_type.strip().casefold()
                if artifact_type and artifact_type.strip()
                else None
            )
        if tags is not UNSET:
            assert isinstance(tags, list)
            normalized = self._safe_tags(tags)
            await session.execute(delete(StorageTag).where(StorageTag.entry_id == entry.id))
            session.add_all(
                [StorageTag(entry_id=entry.id, tag_key=key, tag=value) for key, value in normalized]
            )
        session.add(
            self._event(
                entry.workspace_id,
                entry,
                "entry_updated",
                f"Updated {safe_name}.",
                actor=actor,
            )
        )
        await self._commit_conflict(session, "The destination already contains that name.")
        await session.refresh(entry)
        return await self.entry_view(session, entry)

    async def trash(
        self,
        session: AsyncSession,
        entry_id: str,
        *,
        actor: StorageActor = OWNER_ACTOR,
    ) -> dict[str, Any]:
        entry = await self._entry(session, entry_id)
        workspace = await self._workspace(session, entry.workspace_id, write=True)
        await self._require(session, actor, workspace, "write", entry)
        if entry.trashed_at is not None:
            raise VaultError(409, "This item is already in Trash.")
        affected = await self._subtree(session, entry)
        now = datetime.now(UTC)
        for row in affected:
            row.trashed_at = now
            row.trashed_by_kind = actor.kind
            row.trashed_by_employee_id = actor.employee_id
            row.trashed_by_name = actor.name
        session.add(
            self._event(
                entry.workspace_id,
                entry,
                "entry_trashed",
                f"Moved {entry.name} to Trash.",
                actor=actor,
            )
        )
        await session.commit()
        await session.refresh(entry)
        return await self.entry_view(session, entry)

    async def restore(
        self,
        session: AsyncSession,
        entry_id: str,
        *,
        actor: StorageActor = OWNER_ACTOR,
    ) -> dict[str, Any]:
        entry = await self._entry(session, entry_id)
        workspace = await self._workspace(session, entry.workspace_id, write=True)
        await self._require(session, actor, workspace, "write", entry)
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
            self._event(
                entry.workspace_id,
                entry,
                "entry_restored",
                f"Restored {entry.name}.",
                actor=actor,
            )
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
        tags = list(
            await session.scalars(
                select(StorageTag.tag)
                .where(StorageTag.entry_id == entry.id)
                .order_by(StorageTag.tag)
            )
        )
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
            "tags": tags,
            "favorite": any(tag.casefold() == "favorite" for tag in tags),
            "preview_kind": self._preview_kind(entry, version),
            "trashed_at": entry.trashed_at,
            "created_at": entry.created_at,
            "updated_at": entry.updated_at,
        }

    async def _workspace_view(
        self, session: AsyncSession, workspace: StorageWorkspace
    ) -> dict[str, Any]:
        return {
            "id": workspace.id,
            "scope": workspace.scope,
            "department_key": workspace.department_key,
            "state": workspace.state,
            "used_bytes": await self._usage(session, workspace.id),
            "quota_bytes": self._quota(workspace),
            "quota_override_bytes": workspace.quota_bytes,
        }

    async def _allowed(
        self,
        session: AsyncSession,
        actor: StorageActor,
        workspace: StorageWorkspace,
        permission: str,
        entry: StorageEntry | None = None,
    ) -> bool:
        if actor.kind in {"owner", "system"}:
            return True
        required = PERMISSION_RANK[permission]
        if workspace.scope == StorageWorkspaceScope.COMPANY.value and required <= 1:
            return True
        if workspace.department_key == actor.department_key and required <= 2:
            return True
        now = datetime.now(UTC)
        statements = [
            StorageGrant.workspace_id == workspace.id,
            StorageGrant.revoked_at.is_(None),
            (StorageGrant.expires_at.is_(None) | (StorageGrant.expires_at > now)),
        ]
        identities = []
        if actor.employee_id:
            identities.append(
                (StorageGrant.grantee_kind == StorageGranteeKind.EMPLOYEE.value)
                & (StorageGrant.grantee_id == actor.employee_id)
            )
        if actor.department_key:
            identities.append(
                (StorageGrant.grantee_kind == StorageGranteeKind.DEPARTMENT.value)
                & (StorageGrant.grantee_id == actor.department_key)
            )
        if not identities:
            return False
        identity = identities[0]
        for clause in identities[1:]:
            identity = identity | clause
        grants = list(await session.scalars(select(StorageGrant).where(*statements, identity)))
        for grant in grants:
            if PERMISSION_RANK[grant.permission] < required:
                continue
            if grant.entry_id is None:
                return True
            if entry is None:
                continue
            granted_entry = await session.get(StorageEntry, grant.entry_id)
            if granted_entry and (
                entry.id == granted_entry.id or entry.path.startswith(f"{granted_entry.path}/")
            ):
                return True
        return False

    async def _require(
        self,
        session: AsyncSession,
        actor: StorageActor,
        workspace: StorageWorkspace,
        permission: str,
        entry: StorageEntry | None = None,
    ) -> None:
        if not await self._allowed(session, actor, workspace, permission, entry):
            raise VaultError(403, "This storage actor does not have the required access.")

    async def _validate_link_target(
        self,
        session: AsyncSession,
        workspace: StorageWorkspace,
        target_type: str,
        target_id: str,
    ) -> None:
        if target_type == "task":
            task = await session.get(Task, target_id)
            if task is None:
                raise VaultError(422, "The linked task does not exist.")
            if (
                workspace.scope == StorageWorkspaceScope.DEPARTMENT.value
                and task.department != workspace.department_key
            ):
                raise VaultError(409, "A task must match the artifact workspace department.")
            return
        if target_type == "workflow":
            if await session.get(Workflow, target_id) is None:
                raise VaultError(422, "The linked workflow does not exist.")
            if workspace.scope != StorageWorkspaceScope.COMPANY.value:
                raise VaultError(409, "Workflow reports belong in the company workspace.")
            return
        if target_type == "message":
            try:
                message_id = int(target_id)
            except ValueError as error:
                raise VaultError(422, "The linked message id is invalid.") from error
            message = await session.get(Message, message_id)
            if message is None:
                raise VaultError(422, "The linked message does not exist.")
            conversation = await session.get(Conversation, message.conversation_id)
            if workspace.scope == StorageWorkspaceScope.DEPARTMENT.value and (
                conversation is None or conversation.department != workspace.department_key
            ):
                raise VaultError(409, "A message must match the artifact workspace department.")
            return
        if target_type == "code_run":
            run = await session.get(CodeRun, target_id)
            if run is None:
                raise VaultError(422, "The linked code run does not exist.")
            if workspace.scope == StorageWorkspaceScope.DEPARTMENT.value:
                employee = await session.get(Employee, run.employee_id) if run.employee_id else None
                if employee is None or employee.department != workspace.department_key:
                    raise VaultError(
                        409, "A code run must match the artifact workspace department."
                    )
            return
        if target_type == "app":
            if await session.get(App, target_id) is None:
                raise VaultError(422, "The linked app does not exist.")
        elif target_type == "app_version":
            if await session.get(AppVersion, target_id) is None:
                raise VaultError(422, "The linked app version does not exist.")
        elif target_type == "app_file":
            try:
                app_file_id = int(target_id)
            except ValueError as error:
                raise VaultError(422, "The linked app file id is invalid.") from error
            if await session.get(AppFile, app_file_id) is None:
                raise VaultError(422, "The linked app file does not exist.")
        else:
            raise VaultError(422, "This artifact link target is not supported.")
        if (
            workspace.scope == StorageWorkspaceScope.DEPARTMENT.value
            and workspace.department_key != "engineering"
        ):
            raise VaultError(409, "App artifacts belong in the engineering or company workspace.")

    @staticmethod
    def _grant_view(grant: StorageGrant) -> dict[str, Any]:
        return {
            "id": grant.id,
            "workspace_id": grant.workspace_id,
            "entry_id": grant.entry_id,
            "grantee_kind": grant.grantee_kind,
            "grantee_id": grant.grantee_id,
            "permission": grant.permission,
            "expires_at": grant.expires_at,
            "revoked_at": grant.revoked_at,
            "created_at": grant.created_at,
        }

    @staticmethod
    def _link_view(link: StorageLink) -> dict[str, Any]:
        return {
            "id": link.id,
            "entry_id": link.entry_id,
            "version_id": link.version_id,
            "target_type": link.target_type,
            "target_id": link.target_id,
            "relation": link.relation,
            "label": link.label,
            "created_at": link.created_at,
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

    async def _copy_name(
        self,
        session: AsyncSession,
        workspace_id: str,
        parent: StorageEntry | None,
        source_name: str,
    ) -> str:
        suffix = Path(source_name).suffix if "." in source_name else ""
        stem = source_name[: -len(suffix)] if suffix else source_name
        for number in range(1, 1001):
            label = " copy" if number == 1 else f" copy {number}"
            candidate = self._safe_name(f"{stem}{label}{suffix}")
            path = self._child_path(parent, candidate)
            existing = await session.scalar(
                select(StorageEntry.id).where(
                    StorageEntry.workspace_id == workspace_id,
                    StorageEntry.path_key == logical_path_key(path),
                )
            )
            if existing is None:
                return candidate
        raise VaultError(409, "No available copy name could be generated.")

    @staticmethod
    def _safe_tags(tags: list[str]) -> list[tuple[str, str]]:
        if len(tags) > 20:
            raise VaultError(422, "An item can have at most 20 tags.")
        normalized: dict[str, str] = {}
        for raw in tags:
            value = raw.strip()
            if not value or len(value) > 64 or any(ord(char) < 32 for char in value):
                raise VaultError(422, "Tags must be 1 to 64 printable characters.")
            normalized.setdefault(value.casefold(), value)
        return sorted(normalized.items())

    @staticmethod
    def _preview_kind(entry: StorageEntry, version: StorageVersion | None) -> str:
        if entry.kind == StorageEntryKind.FOLDER.value or version is None:
            return "none"
        extension = Path(entry.name).suffix.casefold()
        mime = version.mime_type.casefold()
        if extension == ".csv":
            return "csv"
        if extension in {
            ".txt",
            ".md",
            ".py",
            ".js",
            ".ts",
            ".tsx",
            ".jsx",
            ".html",
            ".css",
            ".json",
            ".sql",
            ".svg",
        } or mime.startswith("text/"):
            return "text"
        if extension in {".png", ".jpg", ".jpeg", ".webp"}:
            return "image"
        if extension == ".pdf":
            return "pdf"
        if extension in {".mp3", ".wav"}:
            return "audio"
        if extension in {".mp4", ".webm"}:
            return "video"
        return "download"

    @staticmethod
    def _like(value: str) -> str:
        return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

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
        actor: StorageActor = OWNER_ACTOR,
        version: StorageVersion | None = None,
        details: dict[str, object] | None = None,
    ) -> StorageEvent:
        return StorageEvent(
            workspace_id=workspace_id,
            entry_id=entry.id,
            version_id=version.id if version else None,
            level="info",
            kind=kind,
            actor_kind=actor.kind,
            actor_employee_id=actor.employee_id,
            actor_name=actor.name,
            text=text,
            details=details or {},
        )

    @staticmethod
    def _workspace_event(
        workspace_id: str,
        kind: str,
        text: str,
        actor: StorageActor,
        details: dict[str, object] | None = None,
        level: str = "info",
    ) -> StorageEvent:
        return StorageEvent(
            workspace_id=workspace_id,
            level=level,
            kind=kind,
            actor_kind=actor.kind,
            actor_employee_id=actor.employee_id,
            actor_name=actor.name,
            text=text,
            details=details or {},
        )
