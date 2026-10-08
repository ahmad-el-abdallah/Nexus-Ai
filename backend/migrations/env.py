"""Alembic environment (async, SQLite- and PostgreSQL-compatible)."""

from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy.engine import Connection

import app.models  # noqa: F401  (registers all tables on Base.metadata)
from app.core.config import get_settings
from app.db.base import Base
from app.db.session import create_engine

config = context.config
if config.config_file_name is not None and config.attributes.get("configure_logger", True):
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _database_url() -> str:
    return config.get_main_option("sqlalchemy.url") or get_settings().database_url


def _configure(connection: Connection | None = None, url: str | None = None) -> None:
    dialect = connection.dialect.name if connection is not None else url.split(":", 1)[0]
    context.configure(
        connection=connection,
        url=url,
        target_metadata=target_metadata,
        render_as_batch=dialect.startswith("sqlite"),  # SQLite needs batch ALTERs
        compare_type=True,
        literal_binds=connection is None,
    )


def run_migrations_offline() -> None:
    _configure(url=_database_url())
    with context.begin_transaction():
        context.run_migrations()


def _run_sync(connection: Connection) -> None:
    _configure(connection=connection)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    engine = create_engine(_database_url())
    async with engine.connect() as connection:
        if connection.dialect.name == "sqlite":
            # SQLite batch migrations rebuild tables; referenced tables can't be
            # dropped and recreated with FK enforcement on. It is restored per
            # connection at runtime (see app/db/session.py).
            await connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
            await connection.commit()
        await connection.run_sync(_run_sync)
        await connection.commit()
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    connection = config.attributes.get("connection")
    if connection is not None:
        _run_sync(connection)
    else:
        asyncio.run(run_migrations_online())
