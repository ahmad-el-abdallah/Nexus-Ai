"""Workflows (multi-agent orchestration), their timeline, and workflow tasks.

Revision ID: 0007_workflows
Revises: 0006_voice
Create Date: 2026-10-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '0007_workflows'
down_revision: str | None = '0006_voice'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('workflows',
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('title', sa.String(length=160), nullable=False),
    sa.Column('objective', sa.Text(), nullable=False),
    sa.Column('status', sa.String(length=24), nullable=False),
    sa.Column('status_reason', sa.Text(), nullable=True),
    sa.Column('ceo_id', sa.String(length=32), nullable=True),
    sa.Column('plan', sa.JSON(), nullable=True),
    sa.Column('plan_attempts', sa.Integer(), nullable=False),
    sa.Column('result', sa.Text(), nullable=True),
    sa.Column('max_calls', sa.Integer(), nullable=False),
    sa.Column('calls_used', sa.Integer(), nullable=False),
    sa.Column('prompt_tokens', sa.Integer(), nullable=False),
    sa.Column('completion_tokens', sa.Integer(), nullable=False),
    sa.Column('source_conversation_id', sa.String(length=32), nullable=True),
    sa.Column('source_task_id', sa.String(length=32), nullable=True),
    sa.Column('approved_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.ForeignKeyConstraint(['ceo_id'], ['employees.id'], name=op.f('fk_workflows_ceo_id_employees'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['source_conversation_id'], ['conversations.id'], name=op.f('fk_workflows_source_conversation_id_conversations'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_workflows'))
    )
    op.create_table('workflow_events',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('workflow_id', sa.String(length=32), nullable=False),
    sa.Column('task_id', sa.String(length=32), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.Column('kind', sa.String(length=32), nullable=False),
    sa.Column('actor_id', sa.String(length=32), nullable=True),
    sa.Column('actor_name', sa.String(length=80), nullable=True),
    sa.Column('from_department', sa.String(length=40), nullable=True),
    sa.Column('to_department', sa.String(length=40), nullable=True),
    sa.Column('text', sa.Text(), nullable=False),
    sa.ForeignKeyConstraint(['workflow_id'], ['workflows.id'], name=op.f('fk_workflow_events_workflow_id_workflows'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_workflow_events'))
    )
    with op.batch_alter_table('workflow_events', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_workflow_events_workflow_id'), ['workflow_id'], unique=False)

    with op.batch_alter_table('tasks', schema=None) as batch_op:
        batch_op.add_column(sa.Column('kind', sa.String(length=16), server_default='manual', nullable=False))
        batch_op.add_column(sa.Column('workflow_id', sa.String(length=32), nullable=True))
        batch_op.add_column(sa.Column('parent_id', sa.String(length=32), nullable=True))
        batch_op.add_column(sa.Column('depends_on', sa.JSON(), server_default='[]', nullable=False))
        batch_op.add_column(sa.Column('position', sa.Integer(), server_default='0', nullable=False))
        batch_op.add_column(sa.Column('attempts', sa.Integer(), server_default='0', nullable=False))
        batch_op.add_column(sa.Column('revisions', sa.Integer(), server_default='0', nullable=False))
        batch_op.add_column(sa.Column('result', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column('review_notes', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column('error', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column('calls', sa.Integer(), server_default='0', nullable=False))
        batch_op.add_column(sa.Column('prompt_tokens', sa.Integer(), server_default='0', nullable=False))
        batch_op.add_column(sa.Column('completion_tokens', sa.Integer(), server_default='0', nullable=False))
        batch_op.add_column(sa.Column('started_at', sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True))
        batch_op.create_index(batch_op.f('ix_tasks_parent_id'), ['parent_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_tasks_workflow_id'), ['workflow_id'], unique=False)
        batch_op.create_foreign_key(batch_op.f('fk_tasks_workflow_id_workflows'), 'workflows', ['workflow_id'], ['id'], ondelete='CASCADE')
        batch_op.create_foreign_key(batch_op.f('fk_tasks_parent_id_tasks'), 'tasks', ['parent_id'], ['id'], ondelete='CASCADE')



def downgrade() -> None:
    with op.batch_alter_table('tasks', schema=None) as batch_op:
        batch_op.drop_constraint(batch_op.f('fk_tasks_parent_id_tasks'), type_='foreignkey')
        batch_op.drop_constraint(batch_op.f('fk_tasks_workflow_id_workflows'), type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_tasks_workflow_id'))
        batch_op.drop_index(batch_op.f('ix_tasks_parent_id'))
        batch_op.drop_column('finished_at')
        batch_op.drop_column('started_at')
        batch_op.drop_column('completion_tokens')
        batch_op.drop_column('prompt_tokens')
        batch_op.drop_column('calls')
        batch_op.drop_column('error')
        batch_op.drop_column('review_notes')
        batch_op.drop_column('result')
        batch_op.drop_column('revisions')
        batch_op.drop_column('attempts')
        batch_op.drop_column('position')
        batch_op.drop_column('depends_on')
        batch_op.drop_column('parent_id')
        batch_op.drop_column('workflow_id')
        batch_op.drop_column('kind')

    with op.batch_alter_table('workflow_events', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_workflow_events_workflow_id'))

    op.drop_table('workflow_events')
    op.drop_table('workflows')
