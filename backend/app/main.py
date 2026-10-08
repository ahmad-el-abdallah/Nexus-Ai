"""NEXUS AI backend entrypoint.

Run with the app factory: ``uvicorn app.main:create_app --factory``.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import employees, health
from app.core.config import APP_VERSION, Settings, get_settings
from app.core.logging import configure_logging, get_logger
from app.core.middleware import RequestContextMiddleware
from app.db.session import Database

log = get_logger("nexus.app")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_format)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.settings = settings
        app.state.db = Database(settings.database_url)
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
        try:
            yield
        finally:
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
    return app
