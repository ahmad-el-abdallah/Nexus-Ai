"""Read-only Digital Vault status for the Data Center room.

DC-2 exposes aggregate metadata only. It never returns storage keys, server
paths, file names or contents, and it does not pretend that file operations
exist before the storage service is implemented.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.db.session import get_session
from app.models import (
    StorageEntry,
    StorageEntryKind,
    StorageEvent,
    StorageVersion,
    StorageVersionStatus,
    StorageWorkspace,
    StorageWorkspaceScope,
)

router = APIRouter(prefix="/api/storage", tags=["storage"])
Session = Annotated[AsyncSession, Depends(get_session)]


class StorageOverview(BaseModel):
    status: Literal["metadata_ready"] = "metadata_ready"
    backend: str
    writes_enabled: Literal[False] = False
    workspace_count: int
    department_workspace_count: int
    entry_count: int
    file_count: int
    folder_count: int
    version_count: int
    stored_bytes: int
    quota_bytes_per_department: int
    backup_configured: bool
    last_event_at: datetime | None


async def _count(session: AsyncSession, model: type[object], *conditions: object) -> int:
    statement = select(func.count()).select_from(model)
    if conditions:
        statement = statement.where(*conditions)
    return int(await session.scalar(statement) or 0)


@router.get("/overview", response_model=StorageOverview)
async def storage_overview(request: Request, session: Session) -> StorageOverview:
    """Return real aggregate metadata suitable for the public room projection."""
    settings: Settings = request.app.state.settings
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
        stored_bytes=int(stored_bytes or 0),
        quota_bytes_per_department=settings.storage_department_quota_bytes,
        backup_configured=settings.storage_backup_root is not None,
        last_event_at=await session.scalar(select(func.max(StorageEvent.created_at))),
    )
