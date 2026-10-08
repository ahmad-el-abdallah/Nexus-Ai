"""Owner voice preferences (one row). Speech models themselves live on disk."""

from __future__ import annotations

from sqlalchemy import Boolean, Float, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin


class VoiceSettings(TimestampMixin, Base):
    __tablename__ = "voice_settings"

    key: Mapped[str] = mapped_column(String(16), primary_key=True)
    # Which installed speech-recognition model to use.
    stt_model: Mapped[str] = mapped_column(String(64), nullable=False)
    # "auto" (detect) | "en" | "ar"
    language: Mapped[str] = mapped_column(String(8), nullable=False)
    # Read agent replies aloud (in a voice session, or always when enabled).
    speak_replies: Mapped[bool] = mapped_column(Boolean, nullable=False)
    # Master mute for all spoken output.
    muted: Mapped[bool] = mapped_column(Boolean, nullable=False)
    # Piper length scale: >1 slower, <1 faster.
    speech_rate: Mapped[float] = mapped_column(Float, nullable=False)
