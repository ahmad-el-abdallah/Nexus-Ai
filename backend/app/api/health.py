"""Liveness, readiness and system information endpoints."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.ai import ai_status_for_health
from app.api.voice import voice_status_for_health
from app.core.config import APP_VERSION, Settings
from app.core.logging import get_logger
from app.db.migrations import get_migration_state
from app.db.session import Database, get_session
from app.models import AIProviderSettings, SystemMetadata

router = APIRouter(prefix="/api", tags=["system"])
log = get_logger("nexus.health")

ComponentStatus = Literal[
    "ok", "error", "migrations_pending", "planned", "configured", "not_configured", "paused"
]


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

    # AI provider: summarised from settings and the last connection test (no network call).
    ai_cfg = None
    if components["migrations"].status == "ok":
        async with database.sessionmaker() as session:
            ai_cfg = await session.get(AIProviderSettings, "nvidia")
    ai_status, ai_detail, ai_data = ai_status_for_health(ai_cfg, settings)
    components["ai_provider"] = Component(
        status=ai_status, critical=False, detail=ai_detail, data=ai_data
    )
    voice_status, voice_detail, voice_data = voice_status_for_health(request.app.state.voice)
    components["voice"] = Component(
        status=voice_status, critical=False, detail=voice_detail, data=voice_data
    )
    # Email: from the saved accounts and their last connection test (no network call).
    if components["migrations"].status == "ok":
        async with database.sessionmaker() as session:
            mail = await request.app.state.email.health(session)
        email_status: ComponentStatus = {
            "not_configured": "not_configured",
            "not_connected": "configured",
            "ok": "ok",
        }.get(mail["status"], "error")  # type: ignore[assignment]
        email_detail = {
            "not_configured": "No email account connected yet (Settings → Email)",
            "configured": "Account saved but not connected; run the connection test",
            "ok": f"{mail['connected']} account(s) connected",
        }.get(email_status, mail.get("problem"))
        components["email"] = Component(
            status=email_status, critical=False, detail=email_detail, data=mail
        )
    else:
        components["email"] = Component(
            status="error", critical=False, detail="Skipped: database not ready"
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
