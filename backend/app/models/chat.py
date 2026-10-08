"""Owner ↔ AI employee conversations, their messages and attached files."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from sqlalchemy import Boolean, ForeignKey, Integer, LargeBinary, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UTCDateTime


class ConversationKind(StrEnum):
    EMPLOYEE = "employee"  # one specific employee (the CEO is an employee too)
    DEPARTMENT = "department"  # answered by the department's director or most senior member


class MessageRole(StrEnum):
    OWNER = "owner"
    AGENT = "agent"


class MessageStatus(StrEnum):
    COMPLETE = "complete"
    STREAMING = "streaming"
    STOPPED = "stopped"  # the owner pressed stop; content is partial
    ERROR = "error"  # no (complete) reply; `error` says why


class Conversation(TimestampMixin, Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    # Who the conversation is addressed to. Department conversations keep their
    # department; employee conversations keep the employee (and their department
    # at creation, for display if they are later removed).
    department: Mapped[str] = mapped_column(
        String(40), ForeignKey("departments.key"), nullable=False, index=True
    )
    employee_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True, index=True
    )
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    last_message_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    conversation_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), server_default=func.now(), nullable=False
    )
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    # The employee who wrote an agent message, with their name/role at that time
    # so history stays readable after renames or removal.
    employee_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    author_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    author_role: Mapped[str | None] = mapped_column(String(120), nullable=True)
    author_department: Mapped[str | None] = mapped_column(String(40), nullable=True)
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_kind: Mapped[str | None] = mapped_column(String(40), nullable=True)
    # Real measurements from the provider call (null when there was none).
    model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    model_source: Mapped[str | None] = mapped_column(String(32), nullable=True)
    prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    reasoning_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    first_token_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # How many conversation messages (including the latest) the model was given.
    context_messages: Mapped[int | None] = mapped_column(Integer, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class Attachment(Base):
    """A file the owner attached to a message. Text-like files are read into the
    model's context; anything else is stored and labelled as not readable."""

    __tablename__ = "attachments"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    message_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("messages.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), server_default=func.now(), nullable=False
    )
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(120), nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    readable: Mapped[bool] = mapped_column(Boolean, nullable=False)
    # Decoded text of readable files (what the model sees, before truncation).
    text: Mapped[str | None] = mapped_column(Text, nullable=True)
    data: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
