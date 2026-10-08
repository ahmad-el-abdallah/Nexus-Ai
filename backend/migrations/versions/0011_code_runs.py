"""Code runs: employee-written code the owner approved to run in the sandbox.

Revision ID: 0011_code_runs
Revises: 0010_chat_thinking
Create Date: 2026-10-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '0011_code_runs'
down_revision: str | None = '0010_chat_thinking'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('code_runs',
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('language', sa.String(length=16), nullable=False),
    sa.Column('code', sa.Text(), nullable=False),
    sa.Column('code_sha256', sa.String(length=64), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('message_id', sa.Integer(), nullable=True),
    sa.Column('task_id', sa.String(length=32), nullable=True),
    sa.Column('employee_id', sa.String(length=32), nullable=True),
    sa.Column('author_name', sa.String(length=80), nullable=True),
    sa.Column('approved_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('exit_code', sa.Integer(), nullable=True),
    sa.Column('duration_ms', sa.Integer(), nullable=True),
    sa.Column('stdout', sa.Text(), nullable=False),
    sa.Column('stderr', sa.Text(), nullable=False),
    sa.Column('files', sa.JSON(), nullable=False),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], name=op.f('fk_code_runs_employee_id_employees'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['message_id'], ['messages.id'], name=op.f('fk_code_runs_message_id_messages'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['task_id'], ['tasks.id'], name=op.f('fk_code_runs_task_id_tasks'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_code_runs'))
    )
    with op.batch_alter_table('code_runs', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_code_runs_message_id'), ['message_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_code_runs_status'), ['status'], unique=False)
        batch_op.create_index(batch_op.f('ix_code_runs_task_id'), ['task_id'], unique=False)



def downgrade() -> None:
    with op.batch_alter_table('code_runs', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_code_runs_task_id'))
        batch_op.drop_index(batch_op.f('ix_code_runs_status'))
        batch_op.drop_index(batch_op.f('ix_code_runs_message_id'))

    op.drop_table('code_runs')
