"""AI provider settings, model catalogue, usage records and model routing.

Revision ID: 0004_ai_provider
Revises: 0003_departments
Create Date: 2026-10-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004_ai_provider"
down_revision: str | None = "0003_departments"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ai_provider_settings",
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("base_url", sa.String(length=300), nullable=False),
        sa.Column("default_model", sa.String(length=200), nullable=True),
        sa.Column("max_output_tokens", sa.Integer(), nullable=False),
        sa.Column("temperature", sa.Float(), nullable=False),
        sa.Column("timeout_seconds", sa.Integer(), nullable=False),
        sa.Column("concurrency_limit", sa.Integer(), nullable=False),
        sa.Column("daily_request_budget", sa.Integer(), nullable=False),
        sa.Column("paused", sa.Boolean(), nullable=False),
        sa.Column("encrypted_api_key", sa.Text(), nullable=True),
        sa.Column("key_updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_test_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_test_ok", sa.Boolean(), nullable=True),
        sa.Column("last_test_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("provider", name=op.f("pk_ai_provider_settings")),
    )
    op.create_table(
        "ai_models",
        sa.Column("id", sa.String(length=200), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("owned_by", sa.String(length=120), nullable=True),
        sa.Column("discovered_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("listed", sa.Boolean(), nullable=False),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("last_latency_ms", sa.Integer(), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ai_models")),
    )
    op.create_table(
        "ai_usage",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("model", sa.String(length=200), nullable=True),
        sa.Column("employee_id", sa.String(length=32), nullable=True),
        sa.Column("department", sa.String(length=40), nullable=True),
        sa.Column("purpose", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("error_kind", sa.String(length=32), nullable=True),
        sa.Column("http_status", sa.Integer(), nullable=True),
        sa.Column("prompt_tokens", sa.Integer(), nullable=True),
        sa.Column("completion_tokens", sa.Integer(), nullable=True),
        sa.Column("reasoning_tokens", sa.Integer(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("first_token_ms", sa.Integer(), nullable=True),
        sa.Column("retries", sa.Integer(), nullable=False),
        sa.Column("streamed", sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(["employee_id"], ["employees.id"], name=op.f("fk_ai_usage_employee_id_employees"), ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ai_usage")),
    )
    op.create_index(op.f("ix_ai_usage_created_at"), "ai_usage", ["created_at"], unique=False)
    with op.batch_alter_table("departments") as batch:
        batch.add_column(sa.Column("model_id", sa.String(length=200), nullable=True))
    with op.batch_alter_table("employees") as batch:
        batch.add_column(sa.Column("model_id", sa.String(length=200), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("employees") as batch:
        batch.drop_column("model_id")
    with op.batch_alter_table("departments") as batch:
        batch.drop_column("model_id")
    op.drop_index(op.f("ix_ai_usage_created_at"), table_name="ai_usage")
    op.drop_table("ai_usage")
    op.drop_table("ai_models")
    op.drop_table("ai_provider_settings")
