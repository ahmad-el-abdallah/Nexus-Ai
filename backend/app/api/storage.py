"""Owner-facing Digital Vault API with no filesystem paths or storage keys."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Path,
    Query,
    Request,
    Response,
    UploadFile,
)
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
from app.storage.backup import VaultBackup
from app.storage.errors import VaultError
from app.storage.insights import VaultInsights
from app.storage.service import UNSET, VaultService

router = APIRouter(prefix="/api/storage", tags=["storage"])
Session = Annotated[AsyncSession, Depends(get_session)]


def _vault(request: Request) -> VaultService:
    return request.app.state.vault


Vault = Annotated[VaultService, Depends(_vault)]


def _insights(request: Request) -> VaultInsights:
    return VaultInsights(request.app.state.vault)


Insights = Annotated[VaultInsights, Depends(_insights)]


def _backup(request: Request) -> VaultBackup:
    return request.app.state.backup


Backup = Annotated[VaultBackup, Depends(_backup)]
VersionNumber = Annotated[int | None, Query(ge=1)]


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
    backup_snapshot_count: int
    last_backup_at: datetime | None
    unavailable_version_count: int
    integrity_checked_at: datetime | None
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

    target_type: Literal[
        "task", "workflow", "app", "app_version", "app_file", "code_run", "message"
    ]
    target_id: str = Field(min_length=1, max_length=64)
    relation: str = Field(default="source", min_length=1, max_length=32)
    label: str | None = Field(default=None, max_length=160)


class LinkOut(BaseModel):
    id: str
    entry_id: str
    version_id: str | None
    target_type: Literal[
        "task", "workflow", "app", "app_version", "app_file", "code_run", "message"
    ]
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
    tags: list[str]
    favorite: bool
    preview_kind: Literal["none", "text", "csv", "image", "pdf", "audio", "video", "download"]
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
    description: str | None = Field(default=None, max_length=2000)
    artifact_type: str | None = Field(default=None, max_length=40)
    tags: list[str] | None = Field(default=None, max_length=20)


class VersionOut(BaseModel):
    id: str
    number: int
    mime_type: str
    size_bytes: int
    sha256: str
    status: Literal["available", "missing", "quarantined"]
    is_current: bool
    change_description: str | None
    created_by_kind: Literal["owner", "employee", "system"]
    created_by_name: str | None
    created_at: datetime


class EventOut(BaseModel):
    id: int
    kind: str
    level: Literal["info", "warn", "error"]
    actor_name: str | None
    text: str
    created_at: datetime


class EntryDetailOut(EntryOut):
    original_name: str | None
    artifact_type: str | None
    visibility: Literal["private", "department", "shared", "company"]
    created_by_kind: Literal["owner", "employee", "system"]
    created_by_employee_id: str | None
    created_by_name: str | None
    owner_kind: Literal["company", "department", "employee"]
    owner_id: str
    owner_name: str
    # True when the file mirrors a task, workflow, app file, code run or attachment.
    source_managed: bool
    versions: list[VersionOut]
    links: list[LinkOut]
    events: list[EventOut]


class DiffSide(BaseModel):
    entry_id: str
    name: str
    path: str
    version: int
    size_bytes: int
    sha256: str
    created_by_name: str | None
    created_at: datetime


class DiffLine(BaseModel):
    kind: Literal["hunk", "context", "add", "remove"]
    old: int | None
    new: int | None
    text: str


class DiffOut(BaseModel):
    before: DiffSide
    after: DiffSide
    identical: bool
    comparable: bool
    reason: str | None
    line_endings_only: bool
    added: int
    removed: int
    truncated: bool
    lines: list[DiffLine]


class ProjectOut(BaseModel):
    id: str
    name: str
    description: str
    current_version: int
    latest_status: str | None
    version_count: int
    ready_version_count: int
    stored_file_count: int
    stored_bytes: int
    created_at: datetime
    updated_at: datetime


class ProjectFileOut(BaseModel):
    path: str
    area: str
    purpose: str
    author_name: str | None
    author_role: str | None
    entry_id: str | None
    state: str
    size_bytes: int | None
    sha256: str | None
    change: Literal["added", "modified", "unchanged"] | None
    previous_entry_id: str | None


class ProjectVersionOut(BaseModel):
    id: str
    number: int
    base_version: int | None
    status: str
    request: str
    stack: str | None
    tree_sha256: str | None
    finished_at: datetime | None
    folder_id: str | None
    stored_file_count: int
    stored_bytes: int
    files: list[ProjectFileOut]
    removed: list[str]


class ProjectDetailOut(BaseModel):
    id: str
    name: str
    description: str
    current_version: int
    created_at: datetime
    updated_at: datetime
    versions: list[ProjectVersionOut]


class DashboardTotals(BaseModel):
    files: int
    folders: int
    trashed: int
    versions: int
    stored_bytes: int
    unavailable_files: int
    error_events: int
    registration_failures: int


class DashboardWorkspace(WorkspaceOut):
    name: str
    file_count: int


class DashboardType(BaseModel):
    artifact_type: str | None
    files: int
    bytes: int


class DashboardCreatorKind(BaseModel):
    kind: Literal["owner", "employee", "system"]
    files: int


class DashboardCreator(BaseModel):
    employee_id: str
    name: str | None
    files: int


class DashboardDay(BaseModel):
    date: str
    events: int
    errors: int


class DashboardEvent(EventOut):
    workspace_id: str | None


class DashboardProjects(BaseModel):
    apps: int
    ready_versions: int
    stored_files: int


class DashboardOut(BaseModel):
    generated_at: datetime
    utc_offset_minutes: int
    totals: DashboardTotals
    workspaces: list[DashboardWorkspace]
    by_type: list[DashboardType]
    by_creator: list[DashboardCreatorKind]
    top_creators: list[DashboardCreator]
    activity: list[DashboardDay]
    recent_events: list[DashboardEvent]
    projects: DashboardProjects | None


class SearchOut(BaseModel):
    items: list[EntryOut]
    total: int
    offset: int
    limit: int


class DuplicateEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    destination_workspace_id: str | None = Field(default=None, max_length=64)
    destination_parent_id: str | None = Field(default=None, max_length=32)
    name: str | None = Field(default=None, min_length=1, max_length=255)


class ExportCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entry_ids: list[str] = Field(min_length=1, max_length=100)


class PermanentDeleteOut(BaseModel):
    items: int
    versions: int
    blobs_removed: int


class ReconcileOut(BaseModel):
    checked: int
    missing: int
    corrupt: int
    recovered: int
    orphaned: int
    unsafe: int


class GrantDetailOut(GrantOut):
    grantee_name: str | None
    entry_name: str | None
    entry_path: str | None
    entry_kind: Literal["folder", "file"] | None
    inherited: bool


class IntegrityCheck(ReconcileOut):
    at: datetime


class DamagedVersion(BaseModel):
    entry_id: str
    workspace_id: str
    name: str
    path: str
    version: int
    is_current: bool
    status: Literal["missing", "quarantined"]
    size_bytes: int


class IntegrityOut(BaseModel):
    last_check: IntegrityCheck | None
    damaged_total: int
    damaged: list[DamagedVersion]


class CleanupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirm: Literal[True]


class CleanupOut(BaseModel):
    removed_objects: int
    removed_bytes: int
    removed_temporary: int
    kept_recent: int
    unsafe: int


class RepairOut(BaseModel):
    examined: int
    repaired: int
    not_in_backup: int
    failed: int


class BackupSnapshot(BaseModel):
    id: str
    created_at: datetime | None
    status: Literal["complete", "partial", "unreadable"]
    files: int
    versions: int
    bytes: int
    skipped_versions: int
    verified_at: datetime | None
    verified_ok: bool | None


class BackupStatus(BaseModel):
    configured: bool
    same_device: bool | None
    keep: int
    last_backup_at: datetime | None
    snapshots: list[BackupSnapshot]


class BackupCreated(BackupSnapshot):
    pruned_snapshots: int
    pruned_blobs: int
    pruned_bytes: int


class BackupVerifyOut(BaseModel):
    id: str
    healthy: bool
    manifest_ok: bool
    checked: int
    ok: int
    missing: int
    corrupt: int
    verified_at: datetime


class DeletedFile(BaseModel):
    entry_id: str
    workspace_id: str
    name: str
    path: str
    version: int
    size_bytes: int
    recoverable: bool
    # Where identical content already is in the same workspace, if anywhere.
    present_at: str | None


class DeletedFilesOut(BaseModel):
    id: str
    total: int
    items: list[DeletedFile]


class RecoverRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entry_id: str = Field(min_length=1, max_length=32)


async def _count(session: AsyncSession, model: type[object], *conditions: object) -> int:
    statement = select(func.count()).select_from(model)
    if conditions:
        statement = statement.where(*conditions)
    return int(await session.scalar(statement) or 0)


def _raise(error: VaultError) -> None:
    raise HTTPException(error.status, error.detail) from error


@router.get("/overview", response_model=StorageOverview)
async def storage_overview(
    request: Request, session: Session, vault: Vault, backup: Backup
) -> StorageOverview:
    """Return real aggregate metadata suitable for the public room projection."""
    settings: Settings = request.app.state.settings
    await vault.sync_workspaces(session)
    snapshot_count, last_backup_at = await backup.brief()
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
        backup_snapshot_count=snapshot_count,
        last_backup_at=last_backup_at,
        unavailable_version_count=await _count(
            session, StorageVersion, StorageVersion.status != StorageVersionStatus.AVAILABLE.value
        ),
        integrity_checked_at=await session.scalar(
            select(func.max(StorageEvent.created_at)).where(
                StorageEvent.kind == "storage_reconciled"
            )
        ),
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


@router.get("/grants", response_model=list[GrantDetailOut])
async def list_active_grants(
    session: Session,
    vault: Vault,
    entry_id: Annotated[str | None, Query(max_length=32)] = None,
) -> list[dict[str, object]]:
    """Live sharing grants; with an item, only the ones that reach it."""
    try:
        return await vault.active_grants(session, entry_id=entry_id)
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


@router.get("/search", response_model=SearchOut)
async def search_entries(
    session: Session,
    vault: Vault,
    workspace_id: Annotated[str | None, Query(max_length=64)] = None,
    q: Annotated[str | None, Query(max_length=200)] = None,
    kind: Literal["folder", "file"] | None = None,
    tag: Annotated[str | None, Query(max_length=64)] = None,
    trashed: bool = False,
    shared: bool = False,
    sort: Literal["name", "created", "updated", "type"] = "updated",
    order: Literal["asc", "desc"] = "desc",
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> dict[str, object]:
    try:
        return await vault.search(
            session,
            workspace_id=workspace_id,
            query=q,
            kind=kind,
            tag=tag,
            trashed=trashed,
            shared=shared,
            sort=sort,
            descending=order == "desc",
            offset=offset,
            limit=limit,
        )
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
async def download_file(
    entry_id: str, session: Session, vault: Vault, version: VersionNumber = None
) -> StreamingResponse:
    try:
        download = await vault.download(session, entry_id, version_number=version)
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


@router.get("/entries/{entry_id}", response_model=EntryDetailOut)
async def get_entry(entry_id: str, session: Session, vault: Vault) -> dict[str, object]:
    try:
        return await vault.entry_detail(session, entry_id)
    except VaultError as error:
        _raise(error)


@router.post("/entries/{entry_id}/versions", response_model=EntryOut, status_code=201)
async def upload_version(
    entry_id: str,
    session: Session,
    vault: Vault,
    file: Annotated[UploadFile, File()],
    change_description: Annotated[str | None, Form(max_length=500)] = None,
) -> dict[str, object]:
    """Add new content as the next immutable version of an existing file."""
    if not file.filename:
        raise HTTPException(422, "The upload must have a file name.")
    try:
        return await vault.add_version(
            session, entry_id, file.filename, file.content_type, file.read, change_description
        )
    except VaultError as error:
        _raise(error)
    finally:
        await file.close()


@router.post(
    "/entries/{entry_id}/versions/{number}/restore", response_model=EntryOut, status_code=201
)
async def restore_version(
    entry_id: str,
    number: Annotated[int, Path(ge=1)],
    session: Session,
    vault: Vault,
) -> dict[str, object]:
    """Make an older version current by appending a copy; history is not rewritten."""
    try:
        return await vault.restore_version(session, entry_id, number)
    except VaultError as error:
        _raise(error)


@router.get("/diff", response_model=DiffOut)
async def diff_versions(
    session: Session,
    insights: Insights,
    before_entry: Annotated[str, Query(max_length=32)],
    after_entry: Annotated[str, Query(max_length=32)],
    before_version: VersionNumber = None,
    after_version: VersionNumber = None,
) -> dict[str, object]:
    """Bounded line comparison of two stored text versions."""
    try:
        return await insights.diff(
            session,
            before_entry=before_entry,
            before_version=before_version,
            after_entry=after_entry,
            after_version=after_version,
        )
    except VaultError as error:
        _raise(error)


@router.get("/projects", response_model=list[ProjectOut])
async def list_projects(session: Session, insights: Insights) -> list[dict[str, object]]:
    try:
        return await insights.projects(session)
    except VaultError as error:
        _raise(error)


@router.get("/projects/{app_id}", response_model=ProjectDetailOut)
async def get_project(app_id: str, session: Session, insights: Insights) -> dict[str, object]:
    try:
        return await insights.project(session, app_id)
    except VaultError as error:
        _raise(error)


@router.get("/dashboard", response_model=DashboardOut)
async def storage_dashboard(
    session: Session,
    insights: Insights,
    utc_offset_minutes: Annotated[int, Query(ge=-840, le=840)] = 0,
) -> dict[str, object]:
    """Real totals and activity; days are counted in the caller's UTC offset."""
    return await insights.dashboard(session, utc_offset_minutes=utc_offset_minutes)


@router.get("/entries/{entry_id}/preview")
async def preview_entry(
    entry_id: str, session: Session, vault: Vault, version: VersionNumber = None
) -> Response:
    try:
        detail = await vault.entry_detail(session, entry_id)
        download = await vault.download(session, entry_id, version_number=version)
    except VaultError as error:
        _raise(error)
    kind = str(detail["preview_kind"])
    if kind in {"none", "download"}:
        raise HTTPException(415, "A safe browser preview is not available for this file type.")
    headers = {
        "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'none'; script-src 'none'",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
    }
    if kind in {"text", "csv"}:
        maximum = 256 * 1024
        content = bytearray()
        truncated = False
        async for chunk in download.stream:
            remaining = maximum + 1 - len(content)
            content.extend(chunk[:remaining])
            if len(content) > maximum:
                truncated = True
                break
        await download.stream.aclose()
        headers["X-Preview-Truncated"] = "true" if truncated else "false"
        return Response(
            bytes(content[:maximum]).decode("utf-8", errors="replace"),
            media_type="text/plain; charset=utf-8",
            headers=headers,
        )
    headers.update(
        {
            "Content-Disposition": "inline",
            "Content-Length": str(download.size),
            "X-Frame-Options": "SAMEORIGIN",
        }
    )
    return StreamingResponse(download.stream, media_type=download.mime_type, headers=headers)


@router.patch("/entries/{entry_id}", response_model=EntryOut)
async def update_entry(
    entry_id: str, body: EntryUpdate, session: Session, vault: Vault
) -> dict[str, object]:
    if not body.model_fields_set:
        raise HTTPException(422, "Provide an item change.")
    parent: str | object | None = body.parent_id if "parent_id" in body.model_fields_set else UNSET
    description: str | object | None = (
        body.description if "description" in body.model_fields_set else UNSET
    )
    artifact_type: str | object | None = (
        body.artifact_type if "artifact_type" in body.model_fields_set else UNSET
    )
    tags: list[str] | object = body.tags or [] if "tags" in body.model_fields_set else UNSET
    try:
        return await vault.update_entry(
            session,
            entry_id,
            name=body.name,
            parent_id=parent,
            description=description,
            artifact_type=artifact_type,
            tags=tags,
        )
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


@router.post("/entries/{entry_id}/duplicate", response_model=EntryOut, status_code=201)
async def duplicate_entry(
    entry_id: str, body: DuplicateEntry, session: Session, vault: Vault
) -> dict[str, object]:
    try:
        return await vault.duplicate(
            session,
            entry_id,
            destination_workspace_id=body.destination_workspace_id,
            destination_parent_id=body.destination_parent_id,
            name=body.name,
        )
    except VaultError as error:
        _raise(error)


@router.post("/export")
async def export_entries(body: ExportCreate, session: Session, vault: Vault) -> StreamingResponse:
    try:
        archive = await vault.export_zip(session, body.entry_ids)
    except VaultError as error:
        _raise(error)
    encoded_name = quote(archive.name, safe="")
    return StreamingResponse(
        archive.stream,
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}",
            "Content-Length": str(archive.size),
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.delete("/entries/{entry_id}/permanent", response_model=PermanentDeleteOut)
async def permanently_delete_entry(
    entry_id: str,
    session: Session,
    vault: Vault,
    confirm: bool = False,
) -> dict[str, int]:
    if not confirm:
        raise HTTPException(422, "Permanent deletion requires confirm=true.")
    try:
        return await vault.permanent_delete(session, entry_id)
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


@router.get("/maintenance/integrity", response_model=IntegrityOut)
async def storage_integrity(session: Session, vault: Vault) -> dict[str, object]:
    """The last integrity check and the versions currently known to be damaged."""
    return await vault.integrity(session)


@router.post("/maintenance/cleanup", response_model=CleanupOut)
async def cleanup_storage(_body: CleanupRequest, session: Session, vault: Vault) -> dict[str, int]:
    """Remove stored objects that no file refers to, once they are past the grace period.

    The body must be `{"confirm": true}`: removed objects cannot be brought back."""
    return await vault.cleanup(session)


@router.post("/maintenance/repair", response_model=RepairOut)
async def repair_storage(session: Session, backup: Backup) -> dict[str, int]:
    """Check integrity, then restore missing or corrupt versions from the backups."""
    try:
        return await backup.repair(session)
    except VaultError as error:
        _raise(error)


@router.get("/backups", response_model=BackupStatus)
async def list_backups(session: Session, backup: Backup) -> dict[str, object]:
    return await backup.status(session)


@router.post("/backups", response_model=BackupCreated, status_code=201)
async def create_backup(session: Session, backup: Backup) -> dict[str, object]:
    """Copy every stored version to the backup folder and record a verified manifest."""
    try:
        return await backup.create(session)
    except VaultError as error:
        _raise(error)


@router.post("/backups/{snapshot_id}/verify", response_model=BackupVerifyOut)
async def verify_backup(snapshot_id: str, session: Session, backup: Backup) -> dict[str, object]:
    """Re-read every object of one backup and compare it with its checksum."""
    try:
        return await backup.verify(session, snapshot_id)
    except VaultError as error:
        _raise(error)


@router.get("/backups/{snapshot_id}/deleted", response_model=DeletedFilesOut)
async def backup_deleted_files(
    snapshot_id: str, session: Session, backup: Backup
) -> dict[str, object]:
    """Files this backup holds that no longer exist in the Vault."""
    try:
        return await backup.deleted_files(session, snapshot_id)
    except VaultError as error:
        _raise(error)


@router.post("/backups/{snapshot_id}/recover", response_model=EntryOut, status_code=201)
async def recover_from_backup(
    snapshot_id: str, body: RecoverRequest, session: Session, backup: Backup
) -> dict[str, object]:
    """Re-create a deleted file from a backup as a new file; nothing is replaced."""
    try:
        return await backup.recover(session, snapshot_id, body.entry_id)
    except VaultError as error:
        _raise(error)
