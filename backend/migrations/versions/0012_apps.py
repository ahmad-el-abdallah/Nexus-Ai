"""Apps: web applications built by the engineering team, their versions, files and runs.

Revision ID: 0012_apps
Revises: 0011_code_runs
Create Date: 2026-10-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '0012_apps'
down_revision: str | None = '0011_code_runs'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('apps',
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('current_version', sa.Integer(), nullable=False),
    sa.Column('source_conversation_id', sa.String(length=32), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.ForeignKeyConstraint(['source_conversation_id'], ['conversations.id'], name=op.f('fk_apps_source_conversation_id_conversations'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_apps'))
    )
    op.create_table('app_versions',
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('app_id', sa.String(length=32), nullable=False),
    sa.Column('number', sa.Integer(), nullable=False),
    sa.Column('base_version', sa.Integer(), nullable=True),
    sa.Column('request', sa.Text(), nullable=False),
    sa.Column('status', sa.String(length=24), nullable=False),
    sa.Column('status_reason', sa.Text(), nullable=True),
    sa.Column('plan', sa.JSON(), nullable=True),
    sa.Column('plan_attempts', sa.Integer(), nullable=False),
    sa.Column('stack', sa.String(length=24), nullable=True),
    sa.Column('architect_id', sa.String(length=32), nullable=True),
    sa.Column('summary', sa.Text(), nullable=True),
    sa.Column('tree_sha256', sa.String(length=64), nullable=True),
    sa.Column('max_calls', sa.Integer(), nullable=False),
    sa.Column('calls_used', sa.Integer(), nullable=False),
    sa.Column('prompt_tokens', sa.Integer(), nullable=False),
    sa.Column('completion_tokens', sa.Integer(), nullable=False),
    sa.Column('approved_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('reviewed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('fixed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.ForeignKeyConstraint(['app_id'], ['apps.id'], name=op.f('fk_app_versions_app_id_apps'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['architect_id'], ['employees.id'], name=op.f('fk_app_versions_architect_id_employees'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_app_versions')),
    sa.UniqueConstraint('app_id', 'number', name=op.f('uq_app_versions_app_id'))
    )
    with op.batch_alter_table('app_versions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_app_versions_app_id'), ['app_id'], unique=False)

    op.create_table('app_files',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('version_id', sa.String(length=32), nullable=False),
    sa.Column('path', sa.String(length=200), nullable=False),
    sa.Column('position', sa.Integer(), nullable=False),
    sa.Column('area', sa.String(length=16), nullable=False),
    sa.Column('purpose', sa.Text(), nullable=False),
    sa.Column('action', sa.String(length=8), nullable=False),
    sa.Column('instructions', sa.Text(), nullable=True),
    sa.Column('employee_id', sa.String(length=32), nullable=True),
    sa.Column('author_name', sa.String(length=80), nullable=True),
    sa.Column('author_role', sa.String(length=80), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('content', sa.Text(), nullable=False),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('check', sa.String(length=8), nullable=True),
    sa.Column('check_error', sa.Text(), nullable=True),
    sa.Column('review_notes', sa.Text(), nullable=True),
    sa.Column('attempts', sa.Integer(), nullable=False),
    sa.Column('revisions', sa.Integer(), nullable=False),
    sa.Column('calls', sa.Integer(), nullable=False),
    sa.Column('prompt_tokens', sa.Integer(), nullable=False),
    sa.Column('completion_tokens', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], name=op.f('fk_app_files_employee_id_employees'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['version_id'], ['app_versions.id'], name=op.f('fk_app_files_version_id_app_versions'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_app_files')),
    sa.UniqueConstraint('version_id', 'path', name=op.f('uq_app_files_version_id'))
    )
    with op.batch_alter_table('app_files', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_app_files_version_id'), ['version_id'], unique=False)

    op.create_table('app_events',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('app_id', sa.String(length=32), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.Column('kind', sa.String(length=32), nullable=False),
    sa.Column('actor_id', sa.String(length=32), nullable=True),
    sa.Column('actor_name', sa.String(length=80), nullable=True),
    sa.Column('path', sa.String(length=200), nullable=True),
    sa.Column('text', sa.Text(), nullable=False),
    sa.ForeignKeyConstraint(['app_id'], ['apps.id'], name=op.f('fk_app_events_app_id_apps'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_app_events'))
    )
    with op.batch_alter_table('app_events', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_app_events_app_id'), ['app_id'], unique=False)

    op.create_table('app_runs',
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('app_id', sa.String(length=32), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('tree_sha256', sa.String(length=64), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('log', sa.Text(), nullable=False),
    sa.Column('approved_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.ForeignKeyConstraint(['app_id'], ['apps.id'], name=op.f('fk_app_runs_app_id_apps'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_app_runs'))
    )
    with op.batch_alter_table('app_runs', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_app_runs_app_id'), ['app_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_app_runs_status'), ['status'], unique=False)



def downgrade() -> None:
    with op.batch_alter_table('app_runs', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_app_runs_status'))
        batch_op.drop_index(batch_op.f('ix_app_runs_app_id'))

    op.drop_table('app_runs')
    with op.batch_alter_table('app_events', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_app_events_app_id'))

    op.drop_table('app_events')
    with op.batch_alter_table('app_files', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_app_files_version_id'))

    op.drop_table('app_files')
    with op.batch_alter_table('app_versions', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_app_versions_app_id'))

    op.drop_table('app_versions')
    op.drop_table('apps')
