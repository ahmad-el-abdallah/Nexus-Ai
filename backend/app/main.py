"""NEXUS AI backend entrypoint.

Run with the app factory: ``uvicorn app.main:create_app --factory``.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.ai.gateway import AIGateway
from app.api import ai, chat, departments, employees, events, health, tasks, voice
from app.core.config import APP_VERSION, Settings, get_settings
from app.core.events import EventBus, install_shutdown_hook
from app.core.logging import configure_logging, get_logger
from app.core.middleware import RequestContextMiddleware
from app.db.session import Database
from app.services.chat import ChatService
from app.voice.service import VoiceService

log = get_logger("nexus.app")
install_shutdown_hook()


async def _schema_ready(database: Database) -> bool:
    """Startup housekeeping only runs on a migrated database (readiness reports the rest)."""
    try:
        async with database.engine.connect() as connection:
            await connection.execute(text("SELECT 1 FROM messages LIMIT 1"))
        return True
    except Exception:  # missing tables or an unreachable database
        return False


def create_app(
    settings: Settings | None = None,
    ai_transport: httpx.AsyncBaseTransport | None = None,
    voice_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    """The transports let tests replace the network (AI provider, model downloads)."""
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_format)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.settings = settings
        app.state.db = Database(settings.database_url)
        app.state.ai = AIGateway(app.state.db, settings, transport=ai_transport)
        app.state.events = EventBus()
        app.state.chat = ChatService(app.state.db, app.state.ai, app.state.events)
        app.state.voice = VoiceService(settings, app.state.events, transport=voice_transport)
        app.state.started_at = datetime.now(UTC)
        log.info(
            "app.startup",
            version=APP_VERSION,
            environment=settings.env.value,
            database=settings.database_dialect,
            nvidia_key_present=settings.nvidia_api_key is not None,
            secret_key_present=settings.secret_key is not None,
        )
        if settings.secret_key is None:
            log.warning("app.secret_key_missing", hint="Run `make setup` to generate backend/.env")
        if await _schema_ready(app.state.db):
            await app.state.chat.recover()
        try:
            yield
        finally:
            app.state.events.close()
            await app.state.chat.shutdown()
            await app.state.voice.shutdown()
            await app.state.db.dispose()
            log.info("app.shutdown")

    app = FastAPI(
        title="NEXUS AI",
        version=APP_VERSION,
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(RequestContextMiddleware)
    app.include_router(health.router)
    app.include_router(employees.router)
    app.include_router(departments.router)
    app.include_router(ai.router)
    app.include_router(chat.router)
    app.include_router(tasks.router)
    app.include_router(events.router)
    app.include_router(voice.router)
    return app
