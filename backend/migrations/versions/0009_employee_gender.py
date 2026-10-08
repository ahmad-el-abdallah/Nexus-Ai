"""Employee gender (voice, character look, grammatical gender in Arabic).

Revision ID: 0009_employee_gender
Revises: 0008_email
Create Date: 2026-10-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '0009_employee_gender'
down_revision: str | None = '0008_email'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The genders the seeded employees were created with (migrations 0002 and 0003).
FEMALE = (
    "Aria Vance", "Priya Nair", "Hana Kobayashi", "Elena Rossi", "Zara Ahmed", "Maya Goldberg",
    "Iris Wong", "Amara Mensah", "Sofia Lindqvist", "Grace Liu", "Nadia Petrova",
    "Chloé Dubois", "Mei Tanaka", "Fatima Zahra", "Lina Farouk", "Ana Costa", "Yara Nasser",
)
MALE = (
    "Leo Park", "Marcus Bell", "Diego Alvarez", "Samuel Okafor", "Noah Fischer", "Lucas Martin",
    "Omar Haddad", "Felix Schmidt", "Yusuf Demir", "Kenji Watanabe", "Tomás Herrera",
    "Rahul Mehta", "Ibrahim Saleh", "Ethan Brooks", "Daniel Cohen", "Viktor Novak",
    "Peter Walsh", "Arjun Rao",
)
# Seeded staff keep their avatar seed when the owner renames them (migration 0002).
SEED_FEMALE = (101, 202, 204, 301, 303, 305, 401, 403, 405)
SEED_MALE = (102, 201, 203, 205, 302, 304, 306, 402, 404, 406)


def upgrade() -> None:
    with op.batch_alter_table('employees', schema=None) as batch_op:
        batch_op.add_column(sa.Column('gender', sa.String(length=8), nullable=True))
    employees = sa.table(
        'employees', sa.column('name', sa.String), sa.column('avatar_seed', sa.Integer),
        sa.column('gender', sa.String),
    )
    for gender, names, seeds in (('female', FEMALE, SEED_FEMALE), ('male', MALE, SEED_MALE)):
        op.execute(
            employees.update()
            .where(sa.or_(employees.c.name.in_(names), employees.c.avatar_seed.in_(seeds)))
            .values(gender=gender)
        )


def downgrade() -> None:
    with op.batch_alter_table('employees', schema=None) as batch_op:
        batch_op.drop_column('gender')
