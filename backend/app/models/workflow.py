"""Workflows: an owner objective that the CEO plans and the company carries out."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import JSON, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UTCDateTime


class WorkflowStatus(StrEnum):
    PLANNING = "planning"  # the CEO is drafting the plan
    AWAITING_APPROVAL = "awaiting_approval"  # owner checkpoint: nothing runs until approved
    RUNNING = "running"
    CONSOLIDATING = "consolidating"  # the CEO is writing the final report
    PAUSED = "paused"  # stopped safely (budget, emergency stop, restart); owner resumes
    COMPLETED = "completed"
    COMPLETED_WITH_FAILURES = "partial"  # finished, but some departments failed
    FAILED = "failed"
    CANCELLED = "cancelled"


FINISHED = {
    WorkflowStatus.COMPLETED,
    WorkflowStatus.COMPLETED_WITH_FAILURES,
    WorkflowStatus.FAILED,
    WorkflowStatus.CANCELLED,
}


class Workflow(TimestampMixin, Base):
    __tablename__ = "workflows"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    title: Mapped[str] = mapped_column(String(160), nullable=False)
    objective: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    # Why it is paused / failed (shown to the owner).
    status_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    ceo_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    # The CEO's plan as validated JSON (summary, assignments, deliverable).
    plan: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    plan_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # The CEO's consolidated report (Markdown).
    result: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Hard limits (no infinite agent loops) and real usage.
    max_calls: Mapped[int] = mapped_column(Integer, nullable=False)
    calls_used: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    prompt_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    source_conversation_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True
    )
    source_task_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class WorkflowEvent(Base):
    """The workflow's timeline: delegation, hand-offs between departments,
    reviews, retries, failures and owner decisions."""

    __tablename__ = "workflow_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    workflow_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("workflows.id", ondelete="CASCADE"), nullable=False, index=True
    )
    task_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), server_default=func.now(), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    actor_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    actor_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    from_department: Mapped[str | None] = mapped_column(String(40), nullable=True)
    to_department: Mapped[str | None] = mapped_column(String(40), nullable=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
