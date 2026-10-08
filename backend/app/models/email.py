"""Company email: accounts the owner connects, messages (drafts, sent, received)
and a log of everything that happened."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from sqlalchemy import JSON, Boolean, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UTCDateTime


class EmailStatus(StrEnum):
    # Outbound
    DRAFTING = "drafting"  # an AI employee is writing the draft
    DRAFT_FAILED = "draft_failed"  # the AI draft could not be written
    PENDING_APPROVAL = "pending_approval"  # a draft waiting for the owner
    APPROVED = "approved"  # the owner approved it; queued for sending
    SENDING = "sending"
    SENT = "sent"
    FAILED = "failed"  # definitely not sent (safe to retry)
    UNCERTAIN = "uncertain"  # the connection broke mid-send: never resent automatically
    REJECTED = "rejected"  # the owner declined the draft
    # Inbound
    RECEIVED = "received"


class EmailAccount(TimestampMixin, Base):
    __tablename__ = "email_accounts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    label: Mapped[str] = mapped_column(String(80), nullable=False)
    provider: Mapped[str] = mapped_column(String(24), nullable=False)
    auth_method: Mapped[str] = mapped_column(String(16), nullable=False)  # password | oauth
    address: Mapped[str] = mapped_column(String(254), nullable=False)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    username: Mapped[str] = mapped_column(String(254), nullable=False)
    smtp_host: Mapped[str] = mapped_column(String(253), nullable=False)
    smtp_port: Mapped[int] = mapped_column(Integer, nullable=False)
    smtp_security: Mapped[str] = mapped_column(String(10), nullable=False)  # ssl | starttls | none
    imap_host: Mapped[str | None] = mapped_column(String(253), nullable=True)
    imap_port: Mapped[int | None] = mapped_column(Integer, nullable=True)
    imap_security: Mapped[str | None] = mapped_column(String(10), nullable=True)
    # Password, or OAuth tokens as JSON — Fernet-encrypted with NEXUS_SECRET_KEY.
    encrypted_secret: Mapped[str | None] = mapped_column(Text, nullable=True)
    # OAuth client (id + secret) the owner registered with Google / Microsoft (encrypted).
    encrypted_oauth_client: Mapped[str | None] = mapped_column(Text, nullable=True)
    # untested | connected | needs_auth | error | disconnected
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    status_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    last_test_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    last_test_ok: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    last_sync_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    imap_uidvalidity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    imap_last_uid: Mapped[int | None] = mapped_column(Integer, nullable=True)


class EmailMessage(TimestampMixin, Base):
    __tablename__ = "email_messages"
    __table_args__ = (UniqueConstraint("account_id", "message_id_header", "direction"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    account_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("email_accounts.id", ondelete="SET NULL"), nullable=True, index=True
    )
    account_address: Mapped[str] = mapped_column(String(254), nullable=False)
    direction: Mapped[str] = mapped_column(String(10), nullable=False)  # outbound | inbound
    status: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    # Fixed when an outbound draft is created, so a retry can never become a second email.
    message_id_header: Mapped[str] = mapped_column(String(300), nullable=False)
    in_reply_to: Mapped[str | None] = mapped_column(String(300), nullable=True)
    references: Mapped[str | None] = mapped_column(Text, nullable=True)
    from_address: Mapped[str] = mapped_column(String(254), nullable=False)
    from_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    to: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    cc: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    subject: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    body: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # Received mail: attachment names only (never opened), and when it was sent.
    attachments: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    received_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    imap_uid: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Who wrote an outbound draft: an AI employee (with the owner's instructions) or the owner.
    drafted_by_employee_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    drafted_by_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    instructions: Mapped[str | None] = mapped_column(Text, nullable=True)
    model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    reply_to_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("email_messages.id", ondelete="SET NULL"), nullable=True
    )
    approved_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    rejected_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    send_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    server_response: Mapped[str | None] = mapped_column(Text, nullable=True)


class EmailEvent(Base):
    """The email log: connections, tests, syncs, drafts, approvals, sends, failures."""

    __tablename__ = "email_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), server_default=func.now(), nullable=False
    )
    account_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    message_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    level: Mapped[str] = mapped_column(String(8), nullable=False)  # info | warn | error
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
