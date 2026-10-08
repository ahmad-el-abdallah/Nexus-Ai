"""AI employees: the agents that staff the virtual headquarters."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from sqlalchemy import DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin


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
    department: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    seniority: Mapped[str] = mapped_column(String(20), nullable=False)
    # Workstation id from the headquarters layout; null when not seated anywhere.
    desk_id: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    # Seed for the deterministic avatar generator in the frontend.
    avatar_seed: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=EmployeeStatus.IDLE.value
    )
    status_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    status_changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
