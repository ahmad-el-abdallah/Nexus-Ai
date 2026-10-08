"""Email accounts, messages (drafts, sent, received) and the email log.

Revision ID: 0008_email
Revises: 0007_workflows
Create Date: 2026-10-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "0008_email"
down_revision: str | None = "0007_workflows"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "email_accounts",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("label", sa.String(length=80), nullable=False),
        sa.Column("provider", sa.String(length=24), nullable=False),
        sa.Column("auth_method", sa.String(length=16), nullable=False),
        sa.Column("address", sa.String(length=254), nullable=False),
        sa.Column("display_name", sa.String(length=120), nullable=False),
        sa.Column("username", sa.String(length=254), nullable=False),
        sa.Column("smtp_host", sa.String(length=253), nullable=False),
        sa.Column("smtp_port", sa.Integer(), nullable=False),
        sa.Column("smtp_security", sa.String(length=10), nullable=False),
        sa.Column("imap_host", sa.String(length=253), nullable=True),
        sa.Column("imap_port", sa.Integer(), nullable=True),
        sa.Column("imap_security", sa.String(length=10), nullable=True),
        sa.Column("encrypted_secret", sa.Text(), nullable=True),
        sa.Column("encrypted_oauth_client", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("status_detail", sa.Text(), nullable=True),
        sa.Column("is_default", sa.Boolean(), nullable=False),
        sa.Column("last_test_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_test_ok", sa.Boolean(), nullable=True),
        sa.Column("last_sync_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("imap_uidvalidity", sa.Integer(), nullable=True),
        sa.Column("imap_last_uid", sa.Integer(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_email_accounts")),
    )
    op.create_table(
        "email_events",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("account_id", sa.String(length=32), nullable=True),
        sa.Column("message_id", sa.String(length=32), nullable=True),
        sa.Column("level", sa.String(length=8), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_email_events")),
    )
    with op.batch_alter_table("email_events", schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f("ix_email_events_account_id"), ["account_id"], unique=False
        )

    op.create_table(
        "email_messages",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("account_id", sa.String(length=32), nullable=True),
        sa.Column("account_address", sa.String(length=254), nullable=False),
        sa.Column("direction", sa.String(length=10), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("message_id_header", sa.String(length=300), nullable=False),
        sa.Column("in_reply_to", sa.String(length=300), nullable=True),
        sa.Column("references", sa.Text(), nullable=True),
        sa.Column("from_address", sa.String(length=254), nullable=False),
        sa.Column("from_name", sa.String(length=200), nullable=True),
        sa.Column("to", sa.JSON(), nullable=False),
        sa.Column("cc", sa.JSON(), nullable=False),
        sa.Column("subject", sa.String(length=500), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("attachments", sa.JSON(), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("imap_uid", sa.Integer(), nullable=True),
        sa.Column("drafted_by_employee_id", sa.String(length=32), nullable=True),
        sa.Column("drafted_by_name", sa.String(length=80), nullable=True),
        sa.Column("instructions", sa.Text(), nullable=True),
        sa.Column("model", sa.String(length=200), nullable=True),
        sa.Column("reply_to_id", sa.String(length=32), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rejected_reason", sa.Text(), nullable=True),
        sa.Column("send_attempts", sa.Integer(), nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("server_response", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["email_accounts.id"],
            name=op.f("fk_email_messages_account_id_email_accounts"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["drafted_by_employee_id"],
            ["employees.id"],
            name=op.f("fk_email_messages_drafted_by_employee_id_employees"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["reply_to_id"],
            ["email_messages.id"],
            name=op.f("fk_email_messages_reply_to_id_email_messages"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_email_messages")),
        sa.UniqueConstraint(
            "account_id",
            "message_id_header",
            "direction",
            name=op.f("uq_email_messages_account_id"),
        ),
    )
    with op.batch_alter_table("email_messages", schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f("ix_email_messages_account_id"), ["account_id"], unique=False
        )
        batch_op.create_index(batch_op.f("ix_email_messages_status"), ["status"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("email_messages", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_email_messages_status"))
        batch_op.drop_index(batch_op.f("ix_email_messages_account_id"))

    op.drop_table("email_messages")
    with op.batch_alter_table("email_events", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_email_events_account_id"))

    op.drop_table("email_events")
    op.drop_table("email_accounts")
