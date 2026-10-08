from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

import httpx
import pytest
from alembic import command
from fastapi import FastAPI

from app.core.config import Settings
from app.db.migrations import alembic_config
from app.main import create_app

SettingsFactory = Callable[..., Settings]


def run_migrations(database_url: str, target: str = "head", *, down: bool = False) -> None:
    config = alembic_config(database_url)
    config.attributes["configure_logger"] = False
    (command.downgrade if down else command.upgrade)(config, target)


@pytest.fixture
def db_url(tmp_path: Path) -> str:
    return f"sqlite+aiosqlite:///{tmp_path / 'test.db'}"


@pytest.fixture
def migrated_db_url(db_url: str) -> str:
    run_migrations(db_url)
    return db_url


@pytest.fixture
def make_settings() -> SettingsFactory:
    """Hermetic settings: ignores backend/.env and any secrets in the shell."""

    def factory(**overrides: Any) -> Settings:
        values: dict[str, Any] = {
            "NEXUS_ENV": "test",
            "NEXUS_LOG_LEVEL": "WARNING",
            "NEXUS_SECRET_KEY": None,
            "NVIDIA_API_KEY": None,
        }
        values.update(overrides)
        return Settings(_env_file=None, **values)

    return factory


@pytest.fixture
def make_client() -> Callable[[Settings], Any]:
    """Builds an app from settings and yields an HTTP client with lifespan running."""

    class _Client:
        def __init__(self, settings: Settings) -> None:
            self.app: FastAPI = create_app(settings)

        async def __aenter__(self) -> httpx.AsyncClient:
            self._lifespan = self.app.router.lifespan_context(self.app)
            await self._lifespan.__aenter__()
            self._client = httpx.AsyncClient(
                transport=httpx.ASGITransport(app=self.app), base_url="http://test"
            )
            return self._client

        async def __aexit__(self, *exc: object) -> None:
            await self._client.aclose()
            await self._lifespan.__aexit__(None, None, None)

    return _Client


@pytest.fixture
async def client(
    migrated_db_url: str, make_settings: SettingsFactory, make_client: Any
) -> AsyncIterator[httpx.AsyncClient]:
    async with make_client(make_settings(NEXUS_DATABASE_URL=migrated_db_url)) as http:
        yield http
