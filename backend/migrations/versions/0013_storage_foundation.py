"""Digital Vault metadata foundation.

Revision ID: 0013_storage_foundation
Revises: 0012_apps
Create Date: 2026-10-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "0013_storage_foundation"
down_revision: str | None = "0012_apps"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    workspaces = op.create_table(
        "storage_workspaces",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("scope", sa.String(length=16), nullable=False),
        sa.Column("department_key", sa.String(length=40), nullable=True),
        sa.Column("quota_bytes", sa.BigInteger(), nullable=True),
        sa.Column("state", sa.String(length=16), server_default="active", nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "scope IN ('company', 'department')",
            name=op.f("ck_storage_workspaces_scope_values"),
        ),
        sa.CheckConstraint(
            "(scope = 'company' AND department_key IS NULL) OR "
            "(scope = 'department' AND department_key IS NOT NULL)",
            name=op.f("ck_storage_workspaces_scope_department"),
        ),
        sa.CheckConstraint(
            "scope != 'company' OR id = 'ws_company'",
            name=op.f("ck_storage_workspaces_company_identity"),
        ),
        sa.CheckConstraint(
            "quota_bytes IS NULL OR quota_bytes >= 0",
            name=op.f("ck_storage_workspaces_quota_nonnegative"),
        ),
        sa.CheckConstraint(
            "state IN ('active', 'read_only')",
            name=op.f("ck_storage_workspaces_state_values"),
        ),
        sa.ForeignKeyConstraint(
            ["department_key"],
            ["departments.key"],
            name=op.f("fk_storage_workspaces_department_key_departments"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_storage_workspaces")),
        sa.UniqueConstraint(
            "department_key", name=op.f("uq_storage_workspaces_department_key")
        ),
    )

    # Every installed department gets a logical workspace. This intentionally
    # reads the registry instead of repeating its currently seeded keys.
    op.bulk_insert(
        workspaces,
        [
            {
                "id": "ws_company",
                "scope": "company",
                "department_key": None,
                "quota_bytes": None,
                "state": "active",
            }
        ],
    )
    departments = sa.table("departments", sa.column("key", sa.String(length=40)))
    department_workspace_id = sa.literal(
        "ws_department:", type_=sa.String()
    ) + departments.c.key
    op.get_bind().execute(
        sa.insert(workspaces).from_select(
            ["id", "scope", "department_key", "quota_bytes", "state"],
            sa.select(
                department_workspace_id,
                sa.literal("department"),
                departments.c.key,
                sa.null(),
                sa.literal("active"),
            ),
        )
    )

    op.create_table(
        "storage_entries",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("workspace_id", sa.String(length=64), nullable=False),
        sa.Column("parent_id", sa.String(length=32), nullable=True),
        sa.Column("kind", sa.String(length=12), nullable=False),
        sa.Column("path", sa.String(length=1024), nullable=False),
        sa.Column("path_key", sa.String(length=1024), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("original_name", sa.String(length=255), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("artifact_type", sa.String(length=40), nullable=True),
        sa.Column(
            "visibility", sa.String(length=16), server_default="department", nullable=False
        ),
        sa.Column("status", sa.String(length=16), server_default="pending", nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("current_version_number", sa.Integer(), server_default="0", nullable=False),
        sa.Column("created_by_kind", sa.String(length=16), nullable=False),
        sa.Column("created_by_employee_id", sa.String(length=32), nullable=True),
        sa.Column("created_by_name", sa.String(length=120), nullable=True),
        sa.Column("owner_kind", sa.String(length=16), nullable=False),
        sa.Column("owner_id", sa.String(length=64), nullable=False),
        sa.Column("owner_name", sa.String(length=120), nullable=False),
        sa.Column("trashed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("trashed_by_kind", sa.String(length=16), nullable=True),
        sa.Column("trashed_by_employee_id", sa.String(length=32), nullable=True),
        sa.Column("trashed_by_name", sa.String(length=120), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "kind IN ('folder', 'file')", name=op.f("ck_storage_entries_kind_values")
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'available', 'failed', 'missing', 'quarantined')",
            name=op.f("ck_storage_entries_status_values"),
        ),
        sa.CheckConstraint(
            "visibility IN ('private', 'department', 'shared', 'company')",
            name=op.f("ck_storage_entries_visibility_values"),
        ),
        sa.CheckConstraint(
            "created_by_kind IN ('owner', 'employee', 'system')",
            name=op.f("ck_storage_entries_creator_kind_values"),
        ),
        sa.CheckConstraint(
            "owner_kind IN ('company', 'department', 'employee')",
            name=op.f("ck_storage_entries_owner_kind_values"),
        ),
        sa.CheckConstraint(
            "trashed_by_kind IS NULL OR trashed_by_kind IN ('owner', 'employee', 'system')",
            name=op.f("ck_storage_entries_trash_actor_kind_values"),
        ),
        sa.CheckConstraint(
            "path != '' AND path_key != ''", name=op.f("ck_storage_entries_path_nonempty")
        ),
        sa.CheckConstraint(
            "current_version_number >= 0",
            name=op.f("ck_storage_entries_current_version_nonnegative"),
        ),
        sa.CheckConstraint(
            "kind = 'file' OR current_version_number = 0",
            name=op.f("ck_storage_entries_folder_has_no_version"),
        ),
        sa.ForeignKeyConstraint(
            ["created_by_employee_id"],
            ["employees.id"],
            name=op.f("fk_storage_entries_created_by_employee_id_employees"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["parent_id"],
            ["storage_entries.id"],
            name=op.f("fk_storage_entries_parent_id_storage_entries"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["trashed_by_employee_id"],
            ["employees.id"],
            name=op.f("fk_storage_entries_trashed_by_employee_id_employees"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["storage_workspaces.id"],
            name=op.f("fk_storage_entries_workspace_id_storage_workspaces"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_storage_entries")),
        sa.UniqueConstraint(
            "workspace_id", "path_key", name=op.f("uq_storage_entries_workspace_id")
        ),
    )
    op.create_index("ix_storage_entries_parent_id", "storage_entries", ["parent_id"])
    op.create_index(
        "ix_storage_entries_workspace_status",
        "storage_entries",
        ["workspace_id", "status"],
    )

    op.create_table(
        "storage_versions",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("entry_id", sa.String(length=32), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("backend", sa.String(length=24), server_default="local", nullable=False),
        sa.Column("storage_key", sa.String(length=500), nullable=False),
        sa.Column("original_name", sa.String(length=255), nullable=False),
        sa.Column("mime_type", sa.String(length=120), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="available", nullable=False),
        sa.Column("change_description", sa.Text(), nullable=True),
        sa.Column("created_by_kind", sa.String(length=16), nullable=False),
        sa.Column("created_by_employee_id", sa.String(length=32), nullable=True),
        sa.Column("created_by_name", sa.String(length=120), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("number > 0", name=op.f("ck_storage_versions_number_positive")),
        sa.CheckConstraint(
            "size_bytes >= 0", name=op.f("ck_storage_versions_size_nonnegative")
        ),
        sa.CheckConstraint(
            "length(sha256) = 64", name=op.f("ck_storage_versions_sha256_length")
        ),
        sa.CheckConstraint(
            "status IN ('available', 'missing', 'quarantined')",
            name=op.f("ck_storage_versions_status_values"),
        ),
        sa.CheckConstraint(
            "created_by_kind IN ('owner', 'employee', 'system')",
            name=op.f("ck_storage_versions_creator_kind_values"),
        ),
        sa.ForeignKeyConstraint(
            ["created_by_employee_id"],
            ["employees.id"],
            name=op.f("fk_storage_versions_created_by_employee_id_employees"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["entry_id"],
            ["storage_entries.id"],
            name=op.f("fk_storage_versions_entry_id_storage_entries"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_storage_versions")),
        sa.UniqueConstraint(
            "entry_id", "number", name=op.f("uq_storage_versions_entry_id")
        ),
        sa.UniqueConstraint("storage_key", name=op.f("uq_storage_versions_storage_key")),
    )
    op.create_index(
        "ix_storage_versions_entry_status",
        "storage_versions",
        ["entry_id", "status"],
    )
    op.create_index("ix_storage_versions_sha256", "storage_versions", ["sha256"])

    op.create_table(
        "storage_links",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("entry_id", sa.String(length=32), nullable=False),
        sa.Column("version_id", sa.String(length=32), nullable=True),
        sa.Column("target_type", sa.String(length=24), nullable=False),
        sa.Column("target_id", sa.String(length=64), nullable=False),
        sa.Column("relation", sa.String(length=32), server_default="source", nullable=False),
        sa.Column("label", sa.String(length=160), nullable=True),
        sa.Column("idempotency_key", sa.String(length=200), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "target_type IN ('task', 'workflow', 'app', 'app_version', 'app_file', "
            "'code_run', 'message', 'project')",
            name=op.f("ck_storage_links_target_type_values"),
        ),
        sa.CheckConstraint(
            "target_id != '' AND idempotency_key != ''",
            name=op.f("ck_storage_links_target_nonempty"),
        ),
        sa.ForeignKeyConstraint(
            ["entry_id"],
            ["storage_entries.id"],
            name=op.f("fk_storage_links_entry_id_storage_entries"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["version_id"],
            ["storage_versions.id"],
            name=op.f("fk_storage_links_version_id_storage_versions"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_storage_links")),
        sa.UniqueConstraint(
            "idempotency_key", name=op.f("uq_storage_links_idempotency_key")
        ),
    )
    op.create_index("ix_storage_links_entry_id", "storage_links", ["entry_id"])
    op.create_index("ix_storage_links_version_id", "storage_links", ["version_id"])
    op.create_index(
        "ix_storage_links_target", "storage_links", ["target_type", "target_id"]
    )

    op.create_table(
        "storage_tags",
        sa.Column("entry_id", sa.String(length=32), nullable=False),
        sa.Column("tag_key", sa.String(length=64), nullable=False),
        sa.Column("tag", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "tag != '' AND tag_key != ''", name=op.f("ck_storage_tags_tag_nonempty")
        ),
        sa.ForeignKeyConstraint(
            ["entry_id"],
            ["storage_entries.id"],
            name=op.f("fk_storage_tags_entry_id_storage_entries"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("entry_id", "tag_key", name=op.f("pk_storage_tags")),
    )
    op.create_index("ix_storage_tags_tag_key", "storage_tags", ["tag_key"])

    op.create_table(
        "storage_grants",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("workspace_id", sa.String(length=64), nullable=False),
        sa.Column("entry_id", sa.String(length=32), nullable=True),
        sa.Column("grantee_kind", sa.String(length=16), nullable=False),
        sa.Column("grantee_id", sa.String(length=64), nullable=False),
        sa.Column("permission", sa.String(length=16), nullable=False),
        sa.Column("granted_by_kind", sa.String(length=16), nullable=False),
        sa.Column("granted_by_employee_id", sa.String(length=32), nullable=True),
        sa.Column("granted_by_name", sa.String(length=120), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_by_kind", sa.String(length=16), nullable=True),
        sa.Column("revoked_by_employee_id", sa.String(length=32), nullable=True),
        sa.Column("revoked_by_name", sa.String(length=120), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "grantee_kind IN ('department', 'employee')",
            name=op.f("ck_storage_grants_grantee_kind_values"),
        ),
        sa.CheckConstraint(
            "permission IN ('read', 'write', 'manage')",
            name=op.f("ck_storage_grants_permission_values"),
        ),
        sa.CheckConstraint(
            "granted_by_kind IN ('owner', 'employee', 'system')",
            name=op.f("ck_storage_grants_grantor_kind_values"),
        ),
        sa.CheckConstraint(
            "revoked_by_kind IS NULL OR revoked_by_kind IN ('owner', 'employee', 'system')",
            name=op.f("ck_storage_grants_revoker_kind_values"),
        ),
        sa.ForeignKeyConstraint(
            ["entry_id"],
            ["storage_entries.id"],
            name=op.f("fk_storage_grants_entry_id_storage_entries"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["granted_by_employee_id"],
            ["employees.id"],
            name=op.f("fk_storage_grants_granted_by_employee_id_employees"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["revoked_by_employee_id"],
            ["employees.id"],
            name=op.f("fk_storage_grants_revoked_by_employee_id_employees"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["storage_workspaces.id"],
            name=op.f("fk_storage_grants_workspace_id_storage_workspaces"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_storage_grants")),
    )
    op.create_index(
        "ix_storage_grants_workspace_entry",
        "storage_grants",
        ["workspace_id", "entry_id"],
    )
    op.create_index(
        "ix_storage_grants_grantee",
        "storage_grants",
        ["grantee_kind", "grantee_id"],
    )

    op.create_table(
        "storage_events",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("workspace_id", sa.String(length=64), nullable=True),
        sa.Column("entry_id", sa.String(length=32), nullable=True),
        sa.Column("version_id", sa.String(length=32), nullable=True),
        sa.Column("level", sa.String(length=8), server_default="info", nullable=False),
        sa.Column("kind", sa.String(length=40), nullable=False),
        sa.Column("actor_kind", sa.String(length=16), nullable=False),
        sa.Column("actor_employee_id", sa.String(length=32), nullable=True),
        sa.Column("actor_name", sa.String(length=120), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("details", sa.JSON(), server_default="{}", nullable=False),
        sa.CheckConstraint(
            "level IN ('info', 'warn', 'error')",
            name=op.f("ck_storage_events_level_values"),
        ),
        sa.CheckConstraint(
            "actor_kind IN ('owner', 'employee', 'system')",
            name=op.f("ck_storage_events_actor_kind_values"),
        ),
        sa.ForeignKeyConstraint(
            ["actor_employee_id"],
            ["employees.id"],
            name=op.f("fk_storage_events_actor_employee_id_employees"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["entry_id"],
            ["storage_entries.id"],
            name=op.f("fk_storage_events_entry_id_storage_entries"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["version_id"],
            ["storage_versions.id"],
            name=op.f("fk_storage_events_version_id_storage_versions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["storage_workspaces.id"],
            name=op.f("fk_storage_events_workspace_id_storage_workspaces"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_storage_events")),
    )
    op.create_index("ix_storage_events_created_at", "storage_events", ["created_at"])
    op.create_index(
        "ix_storage_events_workspace_created",
        "storage_events",
        ["workspace_id", "created_at"],
    )
    op.create_index("ix_storage_events_entry_id", "storage_events", ["entry_id"])
    op.create_index("ix_storage_events_kind", "storage_events", ["kind"])


def downgrade() -> None:
    op.drop_index("ix_storage_events_kind", table_name="storage_events")
    op.drop_index("ix_storage_events_entry_id", table_name="storage_events")
    op.drop_index("ix_storage_events_workspace_created", table_name="storage_events")
    op.drop_index("ix_storage_events_created_at", table_name="storage_events")
    op.drop_table("storage_events")

    op.drop_index("ix_storage_grants_grantee", table_name="storage_grants")
    op.drop_index("ix_storage_grants_workspace_entry", table_name="storage_grants")
    op.drop_table("storage_grants")

    op.drop_index("ix_storage_tags_tag_key", table_name="storage_tags")
    op.drop_table("storage_tags")

    op.drop_index("ix_storage_links_target", table_name="storage_links")
    op.drop_index("ix_storage_links_version_id", table_name="storage_links")
    op.drop_index("ix_storage_links_entry_id", table_name="storage_links")
    op.drop_table("storage_links")

    op.drop_index("ix_storage_versions_sha256", table_name="storage_versions")
    op.drop_index("ix_storage_versions_entry_status", table_name="storage_versions")
    op.drop_table("storage_versions")

    op.drop_index("ix_storage_entries_workspace_status", table_name="storage_entries")
    op.drop_index("ix_storage_entries_parent_id", table_name="storage_entries")
    op.drop_table("storage_entries")

    op.drop_table("storage_workspaces")
