"""Liveness, readiness and system information endpoints."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import APP_VERSION, Settings
from app.core.logging import get_logger
from app.db.migrations import get_migration_state
from app.db.session import Database, get_session
from app.models import SystemMetadata

router = APIRouter(prefix="/api", tags=["system"])
log = get_logger("nexus.health")

ComponentStatus = Literal["ok", "error", "migrations_pending", "planned"]


class Component(BaseModel):
    status: ComponentStatus
    detail: str | None = None
    critical: bool = True
    data: dict[str, Any] = {}


class Readiness(BaseModel):
    status: Literal["ok", "degraded"]
    checked_at: datetime
    components: dict[str, Component]


class SystemInfo(BaseModel):
    name: str
    version: str
    environment: str
    installation_id: str | None
    started_at: datetime
    uptime_seconds: float
    database_dialect: str
    nvidia_key_present: bool


@router.get("/health/live")
async def live() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/health/ready", response_model=Readiness)
async def ready(request: Request, response: Response) -> Readiness:
    settings: Settings = request.app.state.settings
    database: Database = request.app.state.db
    components: dict[str, Component] = {}

    try:
        async with database.engine.connect() as connection:
            await connection.execute(text("SELECT 1"))
        components["database"] = Component(status="ok", data={"dialect": settings.database_dialect})
    except (SQLAlchemyError, OSError) as exc:
        log.warning("health.database_unreachable", error=type(exc).__name__)
        components["database"] = Component(
            status="error",
            detail="Database is unreachable",
            data={"dialect": settings.database_dialect},
        )

    if components["database"].status == "ok":
        state = await get_migration_state(database.engine)
        components["migrations"] = Component(
            status="ok" if state.up_to_date else "migrations_pending",
            detail=None if state.up_to_date else "Run `make migrate` to apply pending migrations",
            data={"current": state.current, "head": state.head},
        )
    else:
        components["migrations"] = Component(status="error", detail="Skipped: database unreachable")

    # Integrations that do not exist yet are reported honestly, never as "ok".
    components["ai_provider"] = Component(
        status="planned",
        critical=False,
        detail="NVIDIA inference is connected in Stage 5",
        data={"provider": "nvidia", "stage": 5, "key_present": settings.nvidia_api_key is not None},
    )
    components["email"] = Component(
        status="planned",
        critical=False,
        detail="Company email accounts are connected in Stage 9",
        data={"stage": 9},
    )

    healthy = all(c.status == "ok" for c in components.values() if c.critical)
    if not healthy:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return Readiness(
        status="ok" if healthy else "degraded",
        checked_at=datetime.now(UTC),
        components=components,
    )


@router.get("/system/info", response_model=SystemInfo)
async def system_info(
    request: Request, session: Annotated[AsyncSession, Depends(get_session)]
) -> SystemInfo:
    settings: Settings = request.app.state.settings
    started_at: datetime = request.app.state.started_at

    installation_id: str | None
    try:
        installation_id = await session.scalar(
            select(SystemMetadata.value).where(SystemMetadata.key == "installation_id")
        )
    except SQLAlchemyError:
        installation_id = None  # database not migrated or unreachable; /health/ready explains why

    return SystemInfo(
        name="NEXUS AI",
        version=APP_VERSION,
        environment=settings.env.value,
        installation_id=installation_id,
        started_at=started_at,
        uptime_seconds=round((datetime.now(UTC) - started_at).total_seconds(), 1),
        database_dialect=settings.database_dialect,
        nvidia_key_present=settings.nvidia_api_key is not None,
    )
