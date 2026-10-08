"""Company departments: the organisational units AI employees belong to."""

from __future__ import annotations

from sqlalchemy import JSON, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin


class Department(TimestampMixin, Base):
    __tablename__ = "departments"

    key: Mapped[str] = mapped_column(String(40), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    responsibilities: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    # Role titles in this department; the first is the director role.
    roles: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    color: Mapped[str] = mapped_column(String(9), nullable=False)
    # Headquarters room the department works from (null: no office yet).
    room_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    director_id: Mapped[str | None] = mapped_column(
        String(32),
        ForeignKey("employees.id", ondelete="SET NULL", use_alter=True),
        nullable=True,
    )
    # Resource limits, stored now and enforced once agents run (Stages 5 and 8).
    max_concurrent_tasks: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    daily_request_budget: Mapped[int] = mapped_column(Integer, nullable=False, default=200)
