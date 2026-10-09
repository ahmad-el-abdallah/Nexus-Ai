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

from app.ai.gateway import AIGateway
from app.api import (
    ai,
    apps,
    chat,
    departments,
    email,
    employees,
    events,
    health,
    runs,
    tasks,
    voice,
    workflows,
)
from app.apps.builder import AppBuilder
from app.apps.runtime import AppRuntime
from app.core.config import APP_VERSION, Environment, Settings, get_settings
from app.core.events import EventBus, install_shutdown_hook
from app.core.logging import configure_logging, get_logger
from app.core.middleware import RequestContextMiddleware
from app.db.migrations import get_migration_state
from app.db.session import Database
from app.email.service import EmailService
from app.orchestration.engine import Orchestrator
from app.sandbox.service import RunService
from app.services.activity import ActivityTracker
from app.services.chat import ChatService
from app.services.task_runner import TaskRunner
from app.voice.service import VoiceService

log = get_logger("nexus.app")
install_shutdown_hook()


async def _schema_ready(database: Database) -> bool:
    """Startup housekeeping only runs on a fully migrated database (readiness reports
    pending migrations); otherwise a reload before `make migrate` would crash startup."""
    try:
        return (await get_migration_state(database.engine)).up_to_date
    except Exception:  # an unreachable database
        return False


def create_app(
    settings: Settings | None = None,
    ai_transport: httpx.AsyncBaseTransport | None = None,
    voice_transport: httpx.AsyncBaseTransport | None = None,
    email_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    """The transports let tests replace the network (AI provider, model downloads,
    OAuth token endpoints and the Brevo API)."""
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_format)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.settings = settings
        app.state.db = Database(settings.database_url)
        app.state.ai = AIGateway(app.state.db, settings, transport=ai_transport)
        app.state.events = EventBus()
        app.state.activity = ActivityTracker(app.state.db, app.state.events)
        app.state.chat = ChatService(
            app.state.db, app.state.ai, app.state.events, app.state.activity
        )
        app.state.runs = RunService(app.state.db, app.state.events, settings.runs_dir)
        app.state.tasks = TaskRunner(
            app.state.db, app.state.ai, app.state.events, app.state.activity, app.state.chat
        )
        app.state.voice = VoiceService(settings, app.state.events, transport=voice_transport)
        app.state.workflows = Orchestrator(
            app.state.db, app.state.ai, app.state.events, app.state.activity, app.state.chat
        )
        app.state.email = EmailService(
            app.state.db,
            settings,
            app.state.events,
            app.state.activity,
            app.state.ai,
            http_transport=email_transport,
        )
        app.state.apps = AppBuilder(
            app.state.db,
            app.state.ai,
            app.state.events,
            app.state.activity,
            app.state.chat,
            settings.apps_dir / "_checks",
        )
        app.state.app_runtime = AppRuntime(
            app.state.db, app.state.events, settings.apps_dir, settings.app_preview_port
        )
        await app.state.app_runtime.startup()
        if settings.env == Environment.TEST:
            app.state.email.poll_seconds = None  # tests sync the inbox explicitly
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
            await app.state.tasks.recover()
            await app.state.runs.recover()
            await app.state.workflows.recover()
            await app.state.apps.recover()
            await app.state.app_runtime.recover()
            await app.state.activity.recover()
            await app.state.email.recover()
        try:
            yield
        finally:
            app.state.events.close()
            await app.state.workflows.shutdown()
            await app.state.apps.shutdown()
            await app.state.app_runtime.shutdown()
            await app.state.email.shutdown()
            await app.state.tasks.shutdown()
            await app.state.runs.shutdown()
            await app.state.chat.shutdown()
            await app.state.activity.shutdown()
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
    app.include_router(workflows.router)
    app.include_router(email.router)
    app.include_router(runs.router)
    app.include_router(apps.router)
    return app
