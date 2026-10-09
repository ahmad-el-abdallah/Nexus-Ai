"""Employee profiles: skills, the owner's ratings and feedback, and a change history.

Performance is never stored here — it is computed live from verified activity
(tasks, reviews, sandbox runs) so it can't drift from the real record. These tables
hold only what the owner enters (skills, ratings, notes) and an audit trail of changes.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from sqlalchemy import ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UTCDateTime


class EmployeeEventKind(StrEnum):
    HIRED = "hired"
    RENAMED = "renamed"
    ROLE_CHANGED = "role_changed"
    DEPARTMENT_CHANGED = "department_changed"
    SENIORITY_CHANGED = "seniority_changed"
    DESK_CHANGED = "desk_changed"
    MODEL_CHANGED = "model_changed"
    SUSPENDED = "suspended"
    ACTIVATED = "activated"
    RATED = "rated"
    FEEDBACK = "feedback"


class EmployeeEvent(Base):
    """One entry in an employee's history (hiring, role/department changes, ratings…)."""

    __tablename__ = "employee_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    employee_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("employees.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), server_default=func.now(), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(24), nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    from_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    to_value: Mapped[str | None] = mapped_column(Text, nullable=True)


class EmployeeFeedback(Base):
    """A rating (1-5) and/or a note the owner left for an employee."""

    __tablename__ = "employee_feedback"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    employee_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("employees.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), server_default=func.now(), nullable=False
    )
    rating: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 1..5, or null for a note
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
