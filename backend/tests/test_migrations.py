from __future__ import annotations

from pathlib import Path

from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text

import app.models  # noqa: F401
from app.db.base import Base
from app.db.migrations import alembic_config
from tests.conftest import run_migrations


def _sync_url(path: Path) -> str:
    return f"sqlite:///{path}"


def test_upgrade_downgrade_upgrade_roundtrip(tmp_path: Path) -> None:
    db = tmp_path / "roundtrip.db"
    url = f"sqlite+aiosqlite:///{db}"
    run_migrations(url)
    run_migrations(url, "base", down=True)
    engine = create_engine(_sync_url(db))
    with engine.connect() as conn:
        tables = {row[0] for row in conn.execute(text("SELECT name FROM sqlite_master"))}
    assert "system_metadata" not in tables
    assert "employees" not in tables
    run_migrations(url)
    with engine.connect() as conn:
        head = ScriptDirectory.from_config(alembic_config()).get_current_head()
        assert MigrationContext.configure(conn).get_current_revision() == head
    engine.dispose()


def test_models_match_migrations(tmp_path: Path) -> None:
    db = tmp_path / "drift.db"
    run_migrations(f"sqlite+aiosqlite:///{db}")
    engine = create_engine(_sync_url(db))
    with engine.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn), Base.metadata)
    engine.dispose()
    assert diff == [], f"ORM models and migrations differ: {diff}"


def test_installation_id_is_seeded_once(tmp_path: Path) -> None:
    db = tmp_path / "seed.db"
    run_migrations(f"sqlite+aiosqlite:///{db}")
    engine = create_engine(_sync_url(db))
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT value FROM system_metadata WHERE key = 'installation_id'")
        ).all()
    engine.dispose()
    assert len(rows) == 1
    assert len(rows[0][0]) == 32
