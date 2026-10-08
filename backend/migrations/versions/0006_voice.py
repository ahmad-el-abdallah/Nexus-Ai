"""Voice settings and the input mode (text/voice) of messages.

Revision ID: 0006_voice
Revises: 0005_chat
Create Date: 2026-10-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '0006_voice'
down_revision: str | None = '0005_chat'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('voice_settings',
    sa.Column('key', sa.String(length=16), nullable=False),
    sa.Column('stt_model', sa.String(length=64), nullable=False),
    sa.Column('language', sa.String(length=8), nullable=False),
    sa.Column('speak_replies', sa.Boolean(), nullable=False),
    sa.Column('muted', sa.Boolean(), nullable=False),
    sa.Column('speech_rate', sa.Float(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.PrimaryKeyConstraint('key', name=op.f('pk_voice_settings'))
    )
    with op.batch_alter_table('messages', schema=None) as batch_op:
        batch_op.add_column(sa.Column('input_mode', sa.String(length=8), server_default='text', nullable=False))



def downgrade() -> None:
    with op.batch_alter_table('messages', schema=None) as batch_op:
        batch_op.drop_column('input_mode')

    op.drop_table('voice_settings')
