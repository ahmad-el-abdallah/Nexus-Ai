"""Application settings.

All configuration comes from environment variables (optionally loaded from
``backend/.env``). Secrets are typed as ``SecretStr`` so they never appear in
reprs, logs or API responses by accident. Nothing secret has a default value.
"""

from __future__ import annotations

from enum import StrEnum
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]
APP_VERSION = "0.1.0"


class Environment(StrEnum):
    DEVELOPMENT = "development"
    TEST = "test"
    PRODUCTION = "production"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Runtime -----------------------------------------------------------
    env: Environment = Field(default=Environment.DEVELOPMENT, alias="NEXUS_ENV")
    host: str = Field(default="127.0.0.1", alias="NEXUS_HOST")
    port: int = Field(default=8000, alias="NEXUS_PORT")
    log_level: str = Field(default="INFO", alias="NEXUS_LOG_LEVEL")
    log_format: Literal["console", "json"] = Field(default="console", alias="NEXUS_LOG_FORMAT")
    cors_origins: Annotated[list[str], NoDecode] = Field(
        default=["http://localhost:3000", "http://127.0.0.1:3000"],
        alias="NEXUS_CORS_ORIGINS",
    )

    # Where the owner opens NEXUS in the browser (OAuth sign-ins return here).
    public_url: str = Field(default="http://localhost:3000", alias="NEXUS_PUBLIC_URL")
    # Brevo's API (tests point this at a local fake).
    brevo_api_url: str = Field(default="https://api.brevo.com/v3", alias="NEXUS_BREVO_API_URL")

    # --- Persistence ---------------------------------------------------------
    database_url: str = Field(
        default=f"sqlite+aiosqlite:///{BACKEND_DIR / 'var' / 'nexus.db'}",
        alias="NEXUS_DATABASE_URL",
    )

    # --- Secrets (never logged, never returned by the API) --------------------
    # Master key for encrypting credentials stored server-side (used from Stage 9).
    secret_key: SecretStr | None = Field(default=None, alias="NEXUS_SECRET_KEY")

    # --- AI provider (wired up in Stage 5; only presence is reported before then)
    nvidia_api_key: SecretStr | None = Field(default=None, alias="NVIDIA_API_KEY")
    nvidia_base_url: str = Field(
        default="https://integrate.api.nvidia.com/v1", alias="NVIDIA_BASE_URL"
    )

    # --- Voice (Stage 7): local speech models live here, downloaded on request -
    voice_dir: Path = Field(default=BACKEND_DIR / "var" / "voice", alias="NEXUS_VOICE_DIR")
    # Sandbox runs (Stage 9 follow-up): each run's work folder and the files it wrote.
    runs_dir: Path = Field(default=BACKEND_DIR / "var" / "runs", alias="NEXUS_RUNS_DIR")
    # Apps the engineering team builds: each app's folder when it runs (its files,
    # installed packages and the data it stores).
    apps_dir: Path = Field(default=BACKEND_DIR / "var" / "apps", alias="NEXUS_APPS_DIR")
    # Where a running app is reached: http://localhost:<port>, bound to 127.0.0.1.
    # Unset: 8100 (any free port while testing).
    preview_port: int | None = Field(default=None, alias="NEXUS_PREVIEW_PORT", ge=0, le=65535)
    # Test-only stand-in speech engines (refused outside NEXUS_ENV=test).
    voice_fake: bool = Field(default=False, alias="NEXUS_VOICE_FAKE")

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @field_validator("secret_key", "nvidia_api_key", mode="before")
    @classmethod
    def _blank_is_unset(cls, value: object) -> object:
        # An empty `KEY=` line in .env means "not configured", not "empty secret".
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @property
    def app_preview_port(self) -> int:
        if self.preview_port is not None:
            return self.preview_port
        return 0 if self.env == Environment.TEST else 8100

    @property
    def database_dialect(self) -> str:
        return self.database_url.split(":", 1)[0].split("+", 1)[0]


@lru_cache
def get_settings() -> Settings:
    return Settings()
