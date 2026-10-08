"""AI employees, seeded with the initial staff for the Stage 2 rooms.

Revision ID: 0002_employees
Revises: 0001_initial
Create Date: 2026-10-08
"""

import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_employees"
down_revision: str | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# (name, role, department, seniority, desk_id, avatar_seed)
INITIAL_STAFF = [
    ("Aria Vance", "Chief Executive Officer", "executive", "executive", "executive-desk-1", 101),
    ("Leo Park", "Executive Assistant", "executive", "mid", "reception-desk-1", 102),
    ("Marcus Bell", "Sales Director", "sales", "director", "sales-desk-1", 201),
    ("Priya Nair", "Sales Development Representative", "sales", "mid", "sales-desk-2", 202),
    ("Diego Alvarez", "Account Executive", "sales", "senior", "sales-desk-3", 203),
    ("Hana Kobayashi", "Lead Research Specialist", "sales", "mid", "sales-desk-5", 204),
    ("Samuel Okafor", "Sales Operations Analyst", "sales", "mid", "sales-desk-6", 205),
    ("Elena Rossi", "Chief Marketing Officer", "marketing", "executive", "marketing-desk-1", 301),
    ("Noah Fischer", "Marketing Strategist", "marketing", "senior", "marketing-desk-2", 302),
    ("Zara Ahmed", "Social Media Manager", "marketing", "mid", "marketing-desk-3", 303),
    ("Lucas Martin", "SEO Specialist", "marketing", "mid", "marketing-desk-4", 304),
    ("Maya Goldberg", "Content Strategist", "marketing", "senior", "marketing-desk-5", 305),
    ("Omar Haddad", "Growth Specialist", "marketing", "mid", "marketing-desk-6", 306),
    ("Iris Wong", "Chief Technology Officer", "engineering", "executive", "engineering-desk-1", 401),
    ("Felix Schmidt", "Software Architect", "engineering", "senior", "engineering-desk-2", 402),
    ("Amara Mensah", "Frontend Developer", "engineering", "mid", "engineering-desk-3", 403),
    ("Yusuf Demir", "Backend Developer", "engineering", "mid", "engineering-desk-5", 404),
    ("Sofia Lindqvist", "AI Engineer", "engineering", "senior", "engineering-desk-6", 405),
    ("Kenji Watanabe", "DevOps Engineer", "engineering", "mid", "engineering-desk-9", 406),
]


def upgrade() -> None:
    table = op.create_table(
        "employees",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("role", sa.String(length=120), nullable=False),
        sa.Column("department", sa.String(length=40), nullable=False),
        sa.Column("seniority", sa.String(length=20), nullable=False),
        sa.Column("desk_id", sa.String(length=64), nullable=True),
        sa.Column("avatar_seed", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("status_detail", sa.Text(), nullable=True),
        sa.Column("status_changed_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_employees")),
        sa.UniqueConstraint("desk_id", name=op.f("uq_employees_desk_id")),
    )
    op.create_index(op.f("ix_employees_department"), "employees", ["department"], unique=False)
    op.bulk_insert(
        table,
        [
            {
                "id": f"emp_{uuid.uuid4().hex[:12]}",
                "name": name,
                "role": role,
                "department": department,
                "seniority": seniority,
                "desk_id": desk_id,
                "avatar_seed": seed,
                "status": "idle",
            }
            for name, role, department, seniority, desk_id, seed in INITIAL_STAFF
        ],
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_employees_department"), table_name="employees")
    op.drop_table("employees")
