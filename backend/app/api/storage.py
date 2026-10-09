"""Owner-facing Digital Vault API with no filesystem paths or storage keys."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import StreamingResponse

from app.core.config import Settings
from app.db.session import get_session
from app.models import (
    StorageEntry,
    StorageEntryKind,
    StorageEvent,
    StorageGrant,
    StorageLink,
    StorageVersion,
    StorageVersionStatus,
    StorageWorkspace,
    StorageWorkspaceScope,
)
from app.storage.errors import VaultError
from app.storage.service import UNSET, VaultService

router = APIRouter(prefix="/api/storage", tags=["storage"])
Session = Annotated[AsyncSession, Depends(get_session)]


def _vault(request: Request) -> VaultService:
    return request.app.state.vault


Vault = Annotated[VaultService, Depends(_vault)]


class StorageOverview(BaseModel):
    status: Literal["metadata_ready"] = "metadata_ready"
    backend: str
    writes_enabled: Literal[True] = True
    workspace_count: int
    department_workspace_count: int
    entry_count: int
    file_count: int
    folder_count: int
    version_count: int
    active_grant_count: int
    linked_entry_count: int
    read_only_workspace_count: int
    stored_bytes: int
    quota_bytes_per_department: int
    backup_configured: bool
    last_event_at: datetime | None


class WorkspaceOut(BaseModel):
    id: str
    scope: Literal["company", "department"]
    department_key: str | None
    state: Literal["active", "read_only"]
    used_bytes: int
    quota_bytes: int
    quota_override_bytes: int | None


class WorkspaceUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    quota_bytes: int | None = Field(default=None, ge=0)
    state: Literal["active", "read_only"] | None = None


class GrantCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    grantee_kind: Literal["employee", "department"]
    grantee_id: str = Field(min_length=1, max_length=64)
    permission: Literal["read", "write", "manage"]
    entry_id: str | None = Field(default=None, max_length=32)
    expires_at: datetime | None = None


class GrantOut(BaseModel):
    id: str
    workspace_id: str
    entry_id: str | None
    grantee_kind: Literal["employee", "department"]
    grantee_id: str
    permission: Literal["read", "write", "manage"]
    expires_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime


class LinkCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target_type: Literal["task", "app", "app_version"]
    target_id: str = Field(min_length=1, max_length=64)
    relation: str = Field(default="source", min_length=1, max_length=32)
    label: str | None = Field(default=None, max_length=160)


class LinkOut(BaseModel):
    id: str
    entry_id: str
    version_id: str | None
    target_type: Literal["task", "app", "app_version"]
    target_id: str
    relation: str
    label: str | None
    created_at: datetime


class EntryOut(BaseModel):
    id: str
    workspace_id: str
    parent_id: str | None
    kind: Literal["folder", "file"]
    name: str
    path: str
    description: str | None
    status: Literal["pending", "available", "failed", "missing", "quarantined"]
    current_version_number: int
    size_bytes: int | None
    mime_type: str | None
    sha256: str | None
    trashed_at: datetime | None
    created_at: datetime
    updated_at: datetime


class FolderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)
    parent_id: str | None = Field(default=None, max_length=32)


class EntryUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=255)
    parent_id: str | None = Field(default=None, max_length=32)


class ReconcileOut(BaseModel):
    checked: int
    missing: int
    corrupt: int
    recovered: int
    orphaned: int
    unsafe: int


async def _count(session: AsyncSession, model: type[object], *conditions: object) -> int:
    statement = select(func.count()).select_from(model)
    if conditions:
        statement = statement.where(*conditions)
    return int(await session.scalar(statement) or 0)


def _raise(error: VaultError) -> None:
    raise HTTPException(error.status, error.detail) from error


@router.get("/overview", response_model=StorageOverview)
async def storage_overview(request: Request, session: Session, vault: Vault) -> StorageOverview:
    """Return real aggregate metadata suitable for the public room projection."""
    settings: Settings = request.app.state.settings
    await vault.sync_workspaces(session)
    stored_bytes = await session.scalar(
        select(func.coalesce(func.sum(StorageVersion.size_bytes), 0)).where(
            StorageVersion.status == StorageVersionStatus.AVAILABLE.value
        )
    )
    return StorageOverview(
        backend=settings.storage_backend.value,
        workspace_count=await _count(session, StorageWorkspace),
        department_workspace_count=await _count(
            session,
            StorageWorkspace,
            StorageWorkspace.scope == StorageWorkspaceScope.DEPARTMENT.value,
        ),
        entry_count=await _count(session, StorageEntry),
        file_count=await _count(
            session, StorageEntry, StorageEntry.kind == StorageEntryKind.FILE.value
        ),
        folder_count=await _count(
            session, StorageEntry, StorageEntry.kind == StorageEntryKind.FOLDER.value
        ),
        version_count=await _count(session, StorageVersion),
        active_grant_count=await _count(
            session,
            StorageGrant,
            StorageGrant.revoked_at.is_(None),
            (StorageGrant.expires_at.is_(None) | (StorageGrant.expires_at > datetime.now(UTC))),
        ),
        linked_entry_count=int(
            await session.scalar(select(func.count(func.distinct(StorageLink.entry_id)))) or 0
        ),
        read_only_workspace_count=await _count(
            session, StorageWorkspace, StorageWorkspace.state == "read_only"
        ),
        stored_bytes=int(stored_bytes or 0),
        quota_bytes_per_department=settings.storage_department_quota_bytes,
        backup_configured=settings.storage_backup_root is not None,
        last_event_at=await session.scalar(select(func.max(StorageEvent.created_at))),
    )


@router.get("/workspaces", response_model=list[WorkspaceOut])
async def list_workspaces(session: Session, vault: Vault) -> list[dict[str, object]]:
    return await vault.workspaces(session)


@router.patch("/workspaces/{workspace_id}", response_model=WorkspaceOut)
async def update_workspace(
    workspace_id: str, body: WorkspaceUpdate, session: Session, vault: Vault
) -> dict[str, object]:
    if not body.model_fields_set:
        raise HTTPException(422, "Provide a quota or workspace state.")
    quota: int | object | None = (
        body.quota_bytes if "quota_bytes" in body.model_fields_set else UNSET
    )
    try:
        return await vault.update_workspace(
            session, workspace_id, quota_bytes=quota, state=body.state
        )
    except VaultError as error:
        _raise(error)


@router.get("/workspaces/{workspace_id}/grants", response_model=list[GrantOut])
async def list_grants(workspace_id: str, session: Session, vault: Vault) -> list[dict[str, object]]:
    try:
        return await vault.grants(session, workspace_id)
    except VaultError as error:
        _raise(error)


@router.post("/workspaces/{workspace_id}/grants", response_model=GrantOut, status_code=201)
async def create_grant(
    workspace_id: str, body: GrantCreate, session: Session, vault: Vault
) -> dict[str, object]:
    try:
        return await vault.grant_access(
            session,
            workspace_id,
            grantee_kind=body.grantee_kind,
            grantee_id=body.grantee_id,
            permission=body.permission,
            entry_id=body.entry_id,
            expires_at=body.expires_at,
        )
    except VaultError as error:
        _raise(error)


@router.delete("/grants/{grant_id}", response_model=GrantOut)
async def revoke_grant(grant_id: str, session: Session, vault: Vault) -> dict[str, object]:
    try:
        return await vault.revoke_grant(session, grant_id)
    except VaultError as error:
        _raise(error)


@router.get("/workspaces/{workspace_id}/entries", response_model=list[EntryOut])
async def list_entries(
    workspace_id: str,
    session: Session,
    vault: Vault,
    parent_id: Annotated[str | None, Query(max_length=32)] = None,
    trashed: bool = False,
) -> list[dict[str, object]]:
    try:
        return await vault.entries(session, workspace_id, parent_id, trashed=trashed)
    except VaultError as error:
        _raise(error)


@router.post("/workspaces/{workspace_id}/folders", response_model=EntryOut, status_code=201)
async def create_folder(
    workspace_id: str, body: FolderCreate, session: Session, vault: Vault
) -> dict[str, object]:
    try:
        return await vault.create_folder(session, workspace_id, body.name, body.parent_id)
    except VaultError as error:
        _raise(error)


@router.post("/workspaces/{workspace_id}/files", response_model=EntryOut, status_code=201)
async def upload_file(
    workspace_id: str,
    session: Session,
    vault: Vault,
    file: Annotated[UploadFile, File()],
    parent_id: Annotated[str | None, Form(max_length=32)] = None,
    description: Annotated[str | None, Form(max_length=2000)] = None,
) -> dict[str, object]:
    if not file.filename:
        raise HTTPException(422, "The upload must have a file name.")
    try:
        return await vault.upload(
            session,
            workspace_id,
            file.filename,
            file.content_type,
            file.read,
            parent_id,
            description,
        )
    except VaultError as error:
        _raise(error)
    finally:
        await file.close()


@router.get("/entries/{entry_id}/download")
async def download_file(entry_id: str, session: Session, vault: Vault) -> StreamingResponse:
    try:
        download = await vault.download(session, entry_id)
    except VaultError as error:
        _raise(error)
    encoded_name = quote(download.name, safe="")
    return StreamingResponse(
        download.stream,
        media_type=download.mime_type,
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}",
            "Content-Length": str(download.size),
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.patch("/entries/{entry_id}", response_model=EntryOut)
async def update_entry(
    entry_id: str, body: EntryUpdate, session: Session, vault: Vault
) -> dict[str, object]:
    if not body.model_fields_set or (body.model_fields_set == {"name"} and body.name is None):
        raise HTTPException(422, "Provide a name or destination folder.")
    parent: str | object | None = body.parent_id if "parent_id" in body.model_fields_set else UNSET
    try:
        return await vault.update_entry(session, entry_id, name=body.name, parent_id=parent)
    except VaultError as error:
        _raise(error)


@router.delete("/entries/{entry_id}", response_model=EntryOut)
async def trash_entry(entry_id: str, session: Session, vault: Vault) -> dict[str, object]:
    try:
        return await vault.trash(session, entry_id)
    except VaultError as error:
        _raise(error)


@router.post("/entries/{entry_id}/restore", response_model=EntryOut)
async def restore_entry(entry_id: str, session: Session, vault: Vault) -> dict[str, object]:
    try:
        return await vault.restore(session, entry_id)
    except VaultError as error:
        _raise(error)


@router.get("/entries/{entry_id}/links", response_model=list[LinkOut])
async def list_links(entry_id: str, session: Session, vault: Vault) -> list[dict[str, object]]:
    try:
        return await vault.links(session, entry_id)
    except VaultError as error:
        _raise(error)


@router.post("/entries/{entry_id}/links", response_model=LinkOut, status_code=201)
async def create_link(
    entry_id: str, body: LinkCreate, session: Session, vault: Vault
) -> dict[str, object]:
    try:
        return await vault.link_entry(
            session,
            entry_id,
            target_type=body.target_type,
            target_id=body.target_id,
            relation=body.relation,
            label=body.label,
        )
    except VaultError as error:
        _raise(error)


@router.post("/maintenance/reconcile", response_model=ReconcileOut)
async def reconcile_storage(session: Session, vault: Vault) -> dict[str, int]:
    """Validate every version against local storage without deleting orphaned data."""
    return await vault.reconcile(session)
