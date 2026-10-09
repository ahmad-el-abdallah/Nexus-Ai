"""Apps: web applications the engineering team builds for the owner.

An app has versions (the first build, then one per change request). A version holds the
architect's validated design, its files (written by the engineer whose role fits each
file) and what the checks and the review found. Runs are the owner-approved starts of a
finished version in the sandbox.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import JSON, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UTCDateTime


class AppStatus(StrEnum):
    """The state of one version's build."""

    PLANNING = "planning"  # the architect is designing (or planning a change)
    AWAITING_APPROVAL = "awaiting_approval"  # owner checkpoint: nothing is written yet
    BUILDING = "building"  # engineers are writing the files
    CHECKING = "checking"  # automatic syntax checks (no model)
    REVIEWING = "reviewing"
    FIXING = "fixing"  # authors rewrite files that have problems (once)
    DELIVERING = "delivering"  # the CTO writes the delivery note
    READY = "ready"
    PAUSED = "paused"  # stopped safely (budget, emergency stop, restart); owner resumes
    FAILED = "failed"
    CANCELLED = "cancelled"


APP_ACTIVE = (
    AppStatus.PLANNING,
    AppStatus.BUILDING,
    AppStatus.CHECKING,
    AppStatus.REVIEWING,
    AppStatus.FIXING,
    AppStatus.DELIVERING,
)
APP_FINISHED = (AppStatus.READY, AppStatus.FAILED, AppStatus.CANCELLED)


class FileStatus(StrEnum):
    PLANNED = "planned"
    WRITING = "writing"
    FIXING = "fixing"  # its author is rewriting it after the checks or the review
    WRITTEN = "written"
    FAILED = "failed"


class AppRunStatus(StrEnum):
    INSTALLING = "installing"  # packages are being installed in the sandbox
    STARTING = "starting"
    RUNNING = "running"
    STOPPED = "stopped"
    FAILED = "failed"


APP_RUN_ACTIVE = (AppRunStatus.INSTALLING, AppRunStatus.STARTING, AppRunStatus.RUNNING)


class App(TimestampMixin, Base):
    __tablename__ = "apps"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    # What the owner asked for.
    description: Mapped[str] = mapped_column(Text, nullable=False)
    # The number of the newest version.
    current_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    source_conversation_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True
    )


class AppVersion(TimestampMixin, Base):
    __tablename__ = "app_versions"
    __table_args__ = (UniqueConstraint("app_id", "number"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    app_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("apps.id", ondelete="CASCADE"), nullable=False, index=True
    )
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    # The finished version a change request builds on (None for the first build).
    base_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # The owner's request for this version (the description, or the change request).
    request: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    # Why it is paused / failed (shown to the owner).
    status_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The architect's design as validated JSON (summary, stack, api, packages, files).
    plan: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    plan_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    stack: Mapped[str | None] = mapped_column(String(24), nullable=True)
    architect_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    # The CTO's delivery note (Markdown).
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    # SHA-256 over every path and file of the finished version: what the owner approves to run.
    tree_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Hard limits (no endless agent loops) and real usage.
    max_calls: Mapped[int] = mapped_column(Integer, nullable=False)
    calls_used: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    prompt_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    approved_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    fixed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class AppFile(TimestampMixin, Base):
    __tablename__ = "app_files"
    __table_args__ = (UniqueConstraint("version_id", "path"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    version_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("app_versions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    path: Mapped[str] = mapped_column(String(200), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # backend | frontend | setup | docs — decides which role writes the file.
    area: Mapped[str] = mapped_column(String(16), nullable=False)
    purpose: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # new | modify | keep (carried over unchanged from the previous version).
    action: Mapped[str] = mapped_column(String(8), nullable=False, default="new")
    # What to change (change requests only).
    instructions: Mapped[str | None] = mapped_column(Text, nullable=True)
    employee_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    author_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    author_role: Mapped[str | None] = mapped_column(String(80), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The automatic check of the current content: ok | failed | skipped (None: not run yet).
    check: Mapped[str | None] = mapped_column(String(8), nullable=True)
    check_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Problems the reviewer found in this file.
    review_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    revisions: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    calls: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    prompt_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class AppEvent(Base):
    """The app's timeline: design, approvals, who wrote what, checks, reviews, fixes,
    retries, failures and owner decisions."""

    __tablename__ = "app_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    app_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("apps.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), server_default=func.now(), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    actor_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    actor_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    path: Mapped[str | None] = mapped_column(String(200), nullable=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)


class AppRun(TimestampMixin, Base):
    """One owner-approved start of a finished version in the sandbox."""

    __tablename__ = "app_runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    app_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("apps.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    # The exact content the owner approved; it can't be swapped afterwards.
    tree_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The end of the install and app output.
    log: Mapped[str] = mapped_column(Text, nullable=False, default="")
    approved_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
