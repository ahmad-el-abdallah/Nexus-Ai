"""Initial schema: system metadata and installation identity.

Revision ID: 0001_initial
Revises:
Create Date: 2026-10-08
"""

import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001_initial"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    table = op.create_table(
        "system_metadata",
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("key", name=op.f("pk_system_metadata")),
    )
    # A random identifier for this local installation, generated when the
    # database is first created (used for diagnostics, never sent anywhere).
    op.bulk_insert(table, [{"key": "installation_id", "value": uuid.uuid4().hex}])


def downgrade() -> None:
    op.drop_table("system_metadata")
