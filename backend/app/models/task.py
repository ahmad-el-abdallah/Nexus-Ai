"""Tasks: recorded by the owner (e.g. from chat) or created by a workflow.

Workflow tasks come in two kinds:
  * "assignment" — the CEO's assignment to one department (its supervisor plans it);
  * "work"       — a worker task inside an assignment, reviewed by the supervisor.
Owner-recorded tasks ("manual") stay "open" until the owner cancels them or hands
them to the CEO as a workflow.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from sqlalchemy import JSON, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UTCDateTime


class TaskStatus(StrEnum):
    # Manual tasks
    OPEN = "open"
    # Workflow tasks
    PROPOSED = "proposed"  # in a plan awaiting the owner's approval
    QUEUED = "queued"  # ready to start once its dependencies are done
    PLANNING = "planning"  # assignment: the supervisor is splitting it into tasks
    ACTIVE = "active"  # assignment: its worker tasks are in progress
    RUNNING = "running"  # work: the assignee is producing the result
    AWAITING_REVIEW = "awaiting_review"  # work: result ready for the supervisor
    REVIEWING = "reviewing"  # work: the supervisor is reviewing it
    SUMMARIZING = "summarizing"  # assignment: the supervisor is writing the summary
    DONE = "done"
    FAILED = "failed"
    SKIPPED = "skipped"  # a dependency failed or was cancelled
    CANCELLED = "cancelled"


TERMINAL = {TaskStatus.DONE, TaskStatus.FAILED, TaskStatus.SKIPPED, TaskStatus.CANCELLED}


class Task(TimestampMixin, Base):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    title: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    department: Mapped[str] = mapped_column(
        String(40), ForeignKey("departments.key"), nullable=False, index=True
    )
    assignee_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True, index=True
    )
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=TaskStatus.OPEN.value)
    source_conversation_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True
    )
    source_message_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("messages.id", ondelete="SET NULL"), nullable=True
    )
    # --- Workflow tasks (Stage 8) --------------------------------------------
    kind: Mapped[str] = mapped_column(
        String(16), nullable=False, default="manual", server_default="manual"
    )
    workflow_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("workflows.id", ondelete="CASCADE"), nullable=True, index=True
    )
    parent_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=True, index=True
    )
    # Task ids this one waits for (assignments only).
    depends_on: Mapped[list[str]] = mapped_column(
        JSON, nullable=False, default=list, server_default="[]"
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    revisions: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    # The deliverable (Markdown) and the supervisor's last review notes.
    result: Mapped[str | None] = mapped_column(Text, nullable=True)
    review_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Real measurements, summed over this task's model calls.
    calls: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    prompt_tokens: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    completion_tokens: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
