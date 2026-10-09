"""Employee profiles: skills, owner ratings/feedback, and a change history.

Revision ID: 0012_profiles
Revises: 0011_code_runs
Create Date: 2026-10-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '0012_profiles'
down_revision: str | None = '0011_code_runs'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('employee_events',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('employee_id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.Column('kind', sa.String(length=24), nullable=False),
    sa.Column('text', sa.Text(), nullable=False),
    sa.Column('from_value', sa.Text(), nullable=True),
    sa.Column('to_value', sa.Text(), nullable=True),
    sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], name=op.f('fk_employee_events_employee_id_employees'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_employee_events'))
    )
    with op.batch_alter_table('employee_events', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_employee_events_employee_id'), ['employee_id'], unique=False)

    op.create_table('employee_feedback',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('employee_id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.Column('rating', sa.Integer(), nullable=True),
    sa.Column('note', sa.Text(), nullable=True),
    sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], name=op.f('fk_employee_feedback_employee_id_employees'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_employee_feedback'))
    )
    with op.batch_alter_table('employee_feedback', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_employee_feedback_employee_id'), ['employee_id'], unique=False)

    with op.batch_alter_table('employees', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column('skills', sa.JSON(), nullable=False, server_default='[]')
        )



def downgrade() -> None:
    with op.batch_alter_table('employees', schema=None) as batch_op:
        batch_op.drop_column('skills')

    with op.batch_alter_table('employee_feedback', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_employee_feedback_employee_id'))

    op.drop_table('employee_feedback')
    with op.batch_alter_table('employee_events', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_employee_events_employee_id'))

    op.drop_table('employee_events')
