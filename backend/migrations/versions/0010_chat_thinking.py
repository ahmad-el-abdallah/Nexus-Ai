"""Chat replies answer directly by default (reasoning models skip thinking).

Revision ID: 0010_chat_thinking
Revises: 0009_employee_gender
Create Date: 2026-10-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '0010_chat_thinking'
down_revision: str | None = '0009_employee_gender'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table('ai_provider_settings', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column('chat_thinking', sa.Boolean(), server_default=sa.false(), nullable=False)
        )


def downgrade() -> None:
    with op.batch_alter_table('ai_provider_settings', schema=None) as batch_op:
        batch_op.drop_column('chat_thinking')
