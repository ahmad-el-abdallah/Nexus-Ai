"""Helpers for inspecting Alembic migration state at runtime."""

from __future__ import annotations

from dataclasses import dataclass

from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import BACKEND_DIR


def alembic_config(database_url: str | None = None) -> Config:
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    if database_url:
        config.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))
    return config


@dataclass(frozen=True)
class MigrationState:
    current: str | None
    head: str | None

    @property
    def up_to_date(self) -> bool:
        return self.current is not None and self.current == self.head


async def get_migration_state(engine: AsyncEngine) -> MigrationState:
    head = ScriptDirectory.from_config(alembic_config()).get_current_head()

    def _current(connection: Connection) -> str | None:
        return MigrationContext.configure(connection).get_current_revision()

    async with engine.connect() as connection:
        current = await connection.run_sync(_current)
    return MigrationState(current=current, head=head)
