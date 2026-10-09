"""Digital Vault metadata.

Folders and paths in this module are logical database records. Binary contents
are represented by immutable version rows whose opaque storage keys are owned by
the configured blob backend; no server filesystem path is stored or exposed.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UTCDateTime


class StorageWorkspaceScope(StrEnum):
    COMPANY = "company"
    DEPARTMENT = "department"


class StorageWorkspaceState(StrEnum):
    ACTIVE = "active"
    READ_ONLY = "read_only"


class StorageEntryKind(StrEnum):
    FOLDER = "folder"
    FILE = "file"


class StorageEntryStatus(StrEnum):
    PENDING = "pending"
    AVAILABLE = "available"
    FAILED = "failed"
    MISSING = "missing"
    QUARANTINED = "quarantined"


class StorageVisibility(StrEnum):
    PRIVATE = "private"
    DEPARTMENT = "department"
    SHARED = "shared"
    COMPANY = "company"


class StorageActorKind(StrEnum):
    OWNER = "owner"
    EMPLOYEE = "employee"
    SYSTEM = "system"


class StorageOwnerKind(StrEnum):
    COMPANY = "company"
    DEPARTMENT = "department"
    EMPLOYEE = "employee"


class StorageVersionStatus(StrEnum):
    AVAILABLE = "available"
    MISSING = "missing"
    QUARANTINED = "quarantined"


class StorageLinkTarget(StrEnum):
    TASK = "task"
    WORKFLOW = "workflow"
    APP = "app"
    APP_VERSION = "app_version"
    APP_FILE = "app_file"
    CODE_RUN = "code_run"
    MESSAGE = "message"
    PROJECT = "project"


class StorageGranteeKind(StrEnum):
    DEPARTMENT = "department"
    EMPLOYEE = "employee"


class StoragePermission(StrEnum):
    READ = "read"
    WRITE = "write"
    MANAGE = "manage"


class StorageEventLevel(StrEnum):
    INFO = "info"
    WARN = "warn"
    ERROR = "error"


class StorageWorkspace(TimestampMixin, Base):
    """A company-wide or department-owned logical storage namespace."""

    __tablename__ = "storage_workspaces"
    __table_args__ = (
        CheckConstraint("scope IN ('company', 'department')", name="scope_values"),
        CheckConstraint(
            "(scope = 'company' AND department_key IS NULL) OR "
            "(scope = 'department' AND department_key IS NOT NULL)",
            name="scope_department",
        ),
        CheckConstraint("scope != 'company' OR id = 'ws_company'", name="company_identity"),
        CheckConstraint("quota_bytes IS NULL OR quota_bytes >= 0", name="quota_nonnegative"),
        CheckConstraint("state IN ('active', 'read_only')", name="state_values"),
        UniqueConstraint("department_key"),
    )

    # Stable ids make migration seeding and future lazy provisioning idempotent.
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    scope: Mapped[str] = mapped_column(String(16), nullable=False)
    department_key: Mapped[str | None] = mapped_column(
        String(40),
        ForeignKey("departments.key", ondelete="RESTRICT"),
        nullable=True,
    )
    # Null inherits the configured default; usage is always derived from real versions.
    quota_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    state: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default=StorageWorkspaceState.ACTIVE.value,
        server_default=StorageWorkspaceState.ACTIVE.value,
    )


class StorageEntry(TimestampMixin, Base):
    """One logical folder or file in a workspace."""

    __tablename__ = "storage_entries"
    __table_args__ = (
        CheckConstraint("kind IN ('folder', 'file')", name="kind_values"),
        CheckConstraint(
            "status IN ('pending', 'available', 'failed', 'missing', 'quarantined')",
            name="status_values",
        ),
        CheckConstraint(
            "visibility IN ('private', 'department', 'shared', 'company')",
            name="visibility_values",
        ),
        CheckConstraint(
            "created_by_kind IN ('owner', 'employee', 'system')",
            name="creator_kind_values",
        ),
        CheckConstraint(
            "owner_kind IN ('company', 'department', 'employee')", name="owner_kind_values"
        ),
        CheckConstraint(
            "trashed_by_kind IS NULL OR trashed_by_kind IN ('owner', 'employee', 'system')",
            name="trash_actor_kind_values",
        ),
        CheckConstraint("path != '' AND path_key != ''", name="path_nonempty"),
        CheckConstraint("current_version_number >= 0", name="current_version_nonnegative"),
        CheckConstraint(
            "kind = 'file' OR current_version_number = 0", name="folder_has_no_version"
        ),
        UniqueConstraint("workspace_id", "path_key"),
        Index("ix_storage_entries_parent_id", "parent_id"),
        Index("ix_storage_entries_workspace_status", "workspace_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("storage_workspaces.id", ondelete="RESTRICT"), nullable=False
    )
    parent_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("storage_entries.id", ondelete="RESTRICT"), nullable=True
    )
    kind: Mapped[str] = mapped_column(String(12), nullable=False)
    # `path` preserves display case; `path_key` is its NFKC/case-folded uniqueness key.
    path: Mapped[str] = mapped_column(String(1024), nullable=False)
    path_key: Mapped[str] = mapped_column(String(1024), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    original_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    artifact_type: Mapped[str | None] = mapped_column(String(40), nullable=True)
    visibility: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default=StorageVisibility.DEPARTMENT.value,
        server_default=StorageVisibility.DEPARTMENT.value,
    )
    status: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default=StorageEntryStatus.PENDING.value,
        server_default=StorageEntryStatus.PENDING.value,
    )
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    current_version_number: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )

    created_by_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    created_by_employee_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    created_by_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    owner_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    owner_id: Mapped[str] = mapped_column(String(64), nullable=False)
    owner_name: Mapped[str] = mapped_column(String(120), nullable=False)

    trashed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    trashed_by_kind: Mapped[str | None] = mapped_column(String(16), nullable=True)
    trashed_by_employee_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    trashed_by_name: Mapped[str | None] = mapped_column(String(120), nullable=True)


class StorageVersion(TimestampMixin, Base):
    """Immutable content metadata for one real file version."""

    __tablename__ = "storage_versions"
    __table_args__ = (
        CheckConstraint("number > 0", name="number_positive"),
        CheckConstraint("size_bytes >= 0", name="size_nonnegative"),
        CheckConstraint("length(sha256) = 64", name="sha256_length"),
        CheckConstraint("status IN ('available', 'missing', 'quarantined')", name="status_values"),
        CheckConstraint(
            "created_by_kind IN ('owner', 'employee', 'system')",
            name="creator_kind_values",
        ),
        UniqueConstraint("entry_id", "number"),
        UniqueConstraint("storage_key"),
        Index("ix_storage_versions_entry_status", "entry_id", "status"),
        Index("ix_storage_versions_sha256", "sha256"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    entry_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("storage_entries.id", ondelete="CASCADE"), nullable=False
    )
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    backend: Mapped[str] = mapped_column(
        String(24), nullable=False, default="local", server_default="local"
    )
    # Opaque backend key, never a browser-supplied or browser-visible filesystem path.
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False)
    original_name: Mapped[str] = mapped_column(String(255), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(120), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default=StorageVersionStatus.AVAILABLE.value,
        server_default=StorageVersionStatus.AVAILABLE.value,
    )
    change_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    created_by_employee_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    created_by_name: Mapped[str | None] = mapped_column(String(120), nullable=True)


class StorageLink(TimestampMixin, Base):
    """A generic, idempotent link from an artifact to an existing domain object."""

    __tablename__ = "storage_links"
    __table_args__ = (
        CheckConstraint(
            "target_type IN ('task', 'workflow', 'app', 'app_version', 'app_file', "
            "'code_run', 'message', 'project')",
            name="target_type_values",
        ),
        CheckConstraint("target_id != '' AND idempotency_key != ''", name="target_nonempty"),
        UniqueConstraint("idempotency_key"),
        Index("ix_storage_links_entry_id", "entry_id"),
        Index("ix_storage_links_version_id", "version_id"),
        Index("ix_storage_links_target", "target_type", "target_id"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    entry_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("storage_entries.id", ondelete="CASCADE"), nullable=False
    )
    version_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("storage_versions.id", ondelete="SET NULL"), nullable=True
    )
    target_type: Mapped[str] = mapped_column(String(24), nullable=False)
    target_id: Mapped[str] = mapped_column(String(64), nullable=False)
    relation: Mapped[str] = mapped_column(
        String(32), nullable=False, default="source", server_default="source"
    )
    label: Mapped[str | None] = mapped_column(String(160), nullable=True)
    idempotency_key: Mapped[str] = mapped_column(String(200), nullable=False)


class StorageTag(Base):
    """A case-preserving tag with a normalised key for search and uniqueness."""

    __tablename__ = "storage_tags"
    __table_args__ = (
        CheckConstraint("tag != '' AND tag_key != ''", name="tag_nonempty"),
        Index("ix_storage_tags_tag_key", "tag_key"),
    )

    entry_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("storage_entries.id", ondelete="CASCADE"), primary_key=True
    )
    tag_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    tag: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), server_default=func.now(), nullable=False
    )


class StorageGrant(TimestampMixin, Base):
    """A department or employee permission on a workspace or one of its entries."""

    __tablename__ = "storage_grants"
    __table_args__ = (
        CheckConstraint("grantee_kind IN ('department', 'employee')", name="grantee_kind_values"),
        CheckConstraint("permission IN ('read', 'write', 'manage')", name="permission_values"),
        CheckConstraint(
            "granted_by_kind IN ('owner', 'employee', 'system')",
            name="grantor_kind_values",
        ),
        CheckConstraint(
            "revoked_by_kind IS NULL OR revoked_by_kind IN ('owner', 'employee', 'system')",
            name="revoker_kind_values",
        ),
        Index("ix_storage_grants_workspace_entry", "workspace_id", "entry_id"),
        Index("ix_storage_grants_grantee", "grantee_kind", "grantee_id"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("storage_workspaces.id", ondelete="RESTRICT"), nullable=False
    )
    # Null grants workspace-wide access. Entry deletion removes entry-scoped grants,
    # never widens them into workspace grants.
    entry_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("storage_entries.id", ondelete="CASCADE"), nullable=True
    )
    grantee_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    grantee_id: Mapped[str] = mapped_column(String(64), nullable=False)
    permission: Mapped[str] = mapped_column(String(16), nullable=False)
    granted_by_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    granted_by_employee_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    granted_by_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    revoked_by_kind: Mapped[str | None] = mapped_column(String(16), nullable=True)
    revoked_by_employee_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    revoked_by_name: Mapped[str | None] = mapped_column(String(120), nullable=True)


class StorageEvent(Base):
    """Append-only audit and operation history for the Digital Vault."""

    __tablename__ = "storage_events"
    __table_args__ = (
        CheckConstraint("level IN ('info', 'warn', 'error')", name="level_values"),
        CheckConstraint("actor_kind IN ('owner', 'employee', 'system')", name="actor_kind_values"),
        Index("ix_storage_events_created_at", "created_at"),
        Index("ix_storage_events_workspace_created", "workspace_id", "created_at"),
        Index("ix_storage_events_entry_id", "entry_id"),
        Index("ix_storage_events_kind", "kind"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), server_default=func.now(), nullable=False
    )
    workspace_id: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("storage_workspaces.id", ondelete="SET NULL"), nullable=True
    )
    entry_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("storage_entries.id", ondelete="SET NULL"), nullable=True
    )
    version_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("storage_versions.id", ondelete="SET NULL"), nullable=True
    )
    level: Mapped[str] = mapped_column(
        String(8),
        nullable=False,
        default=StorageEventLevel.INFO.value,
        server_default=StorageEventLevel.INFO.value,
    )
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    actor_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    actor_employee_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    actor_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    # Structured facts only: never file content, secrets or absolute server paths.
    details: Mapped[dict[str, object]] = mapped_column(
        JSON, nullable=False, default=dict, server_default="{}"
    )
