"""AI employees: the agents that staff the virtual headquarters."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from sqlalchemy import ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UTCDateTime


class EmployeeStatus(StrEnum):
    """Work status. Only the owner's suspend/activate changes it before Stage 8;
    the task system sets the working states once it exists."""

    IDLE = "idle"
    ASSIGNED = "assigned"
    WORKING = "working"
    RESEARCHING = "researching"
    MEETING = "meeting"
    REVIEWING = "reviewing"
    BLOCKED = "blocked"
    COMPLETED = "completed"
    ERROR = "error"
    SUSPENDED = "suspended"


class Employee(TimestampMixin, Base):
    __tablename__ = "employees"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    role: Mapped[str] = mapped_column(String(120), nullable=False)
    department: Mapped[str] = mapped_column(
        String(40), ForeignKey("departments.key"), nullable=False, index=True
    )
    seniority: Mapped[str] = mapped_column(String(20), nullable=False)
    # Workstation id from the headquarters layout; null when not seated anywhere.
    desk_id: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    # Manager in the reporting hierarchy (null only for the CEO).
    supervisor_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    # Model override (null: inherit). Resolution: employee → department → provider default.
    model_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # Seed for the deterministic avatar generator in the frontend.
    avatar_seed: Mapped[int] = mapped_column(Integer, nullable=False)
    # "female" | "male" (null: not set). Drives the voice, the character's look and
    # grammatical gender when the employee speaks Arabic.
    gender: Mapped[str | None] = mapped_column(String(8), nullable=True)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=EmployeeStatus.IDLE.value
    )
    status_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    status_changed_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), server_default=func.now(), nullable=False
    )
