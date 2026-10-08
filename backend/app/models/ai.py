"""AI provider configuration, model catalogue and usage records."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UTCDateTime


class AIProviderSettings(TimestampMixin, Base):
    """One row per provider (currently only "nvidia")."""

    __tablename__ = "ai_provider_settings"

    provider: Mapped[str] = mapped_column(String(32), primary_key=True)
    base_url: Mapped[str] = mapped_column(String(300), nullable=False)
    default_model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    max_output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=1024)
    temperature: Mapped[float] = mapped_column(Float, nullable=False, default=0.4)
    timeout_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=60)
    concurrency_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    daily_request_budget: Mapped[int] = mapped_column(Integer, nullable=False, default=500)
    # Emergency stop: when true, no request leaves the application.
    paused: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # API key saved through the app, encrypted with NEXUS_SECRET_KEY (never plaintext).
    encrypted_api_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    key_updated_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    last_test_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    last_test_ok: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    last_test_message: Mapped[str | None] = mapped_column(Text, nullable=True)


class AIModel(Base):
    """A model listed by the provider. Listed does not mean usable: `verified_at`
    records a successful test call for this account."""

    __tablename__ = "ai_models"

    id: Mapped[str] = mapped_column(String(200), primary_key=True)
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    owned_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    discovered_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), server_default=func.now(), nullable=False
    )
    listed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    verified_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    last_checked_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)


class AIUsage(Base):
    """One row per request attempt. Prompts and replies are never stored here."""

    __tablename__ = "ai_usage"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), server_default=func.now(), nullable=False, index=True
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    employee_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    department: Mapped[str | None] = mapped_column(String(40), nullable=True)
    purpose: Mapped[str] = mapped_column(String(32), nullable=False)
    # ok | error | rejected (blocked locally, nothing sent)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    error_kind: Mapped[str | None] = mapped_column(String(32), nullable=True)
    http_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    reasoning_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    first_token_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    retries: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    streamed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
