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

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]
APP_VERSION = "0.1.0"


class Environment(StrEnum):
    DEVELOPMENT = "development"
    TEST = "test"
    PRODUCTION = "production"


class StorageBackend(StrEnum):
    """Durable artifact bytes. Stage DC-1 intentionally enables local storage only."""

    LOCAL = "local"


DEFAULT_STORAGE_EXTENSIONS = [
    ".css",
    ".csv",
    ".docx",
    ".html",
    ".jpeg",
    ".jpg",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".mp3",
    ".mp4",
    ".pdf",
    ".png",
    ".pptx",
    ".py",
    ".sql",
    ".svg",
    ".ts",
    ".tsx",
    ".txt",
    ".wav",
    ".webm",
    ".webp",
    ".xlsx",
    ".zip",
]


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

    # --- Digital Vault (Data Center feature) -------------------------------
    # Metadata lives in the application database. File bytes live below this
    # private root under opaque keys and are never addressed by browser paths.
    storage_backend: StorageBackend = Field(
        default=StorageBackend.LOCAL, alias="NEXUS_STORAGE_BACKEND"
    )
    storage_root: Path = Field(default=BACKEND_DIR / "var" / "storage", alias="NEXUS_STORAGE_ROOT")
    storage_max_file_bytes: int = Field(
        default=100 * 1024 * 1024,
        alias="NEXUS_STORAGE_MAX_FILE_BYTES",
        ge=1,
    )
    storage_department_quota_bytes: int = Field(
        default=10 * 1024 * 1024 * 1024,
        alias="NEXUS_STORAGE_DEPARTMENT_QUOTA_BYTES",
        ge=1,
    )
    storage_allowed_extensions: Annotated[list[str], NoDecode] = Field(
        default=DEFAULT_STORAGE_EXTENSIONS.copy(),
        alias="NEXUS_STORAGE_ALLOWED_EXTENSIONS",
    )
    # Backups are deliberately disabled until DC-8 implements and verifies
    # restore. When configured, this must be a separate tree from storage_root.
    storage_backup_root: Path | None = Field(default=None, alias="NEXUS_STORAGE_BACKUP_ROOT")

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

    @field_validator("storage_allowed_extensions", mode="before")
    @classmethod
    def _split_storage_extensions(cls, value: object) -> object:
        if isinstance(value, str):
            value = [item.strip() for item in value.split(",") if item.strip()]
        return value

    @field_validator("storage_allowed_extensions")
    @classmethod
    def _normalise_storage_extensions(cls, value: list[str]) -> list[str]:
        normalised: list[str] = []
        for extension in value:
            item = extension.strip().lower()
            if not item:
                continue
            if not item.startswith("."):
                item = f".{item}"
            if item == "." or any(char in item for char in ("/", "\\", "\x00")):
                raise ValueError(f"Invalid storage extension: {extension!r}")
            if item not in normalised:
                normalised.append(item)
        if not normalised:
            raise ValueError("At least one storage extension must be allowed")
        return normalised

    @field_validator("storage_root", mode="before")
    @classmethod
    def _storage_root_must_be_set(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            raise ValueError("NEXUS_STORAGE_ROOT cannot be empty")
        return value

    @field_validator("storage_backup_root", mode="before")
    @classmethod
    def _blank_backup_path_is_unset(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("storage_root", "storage_backup_root")
    @classmethod
    def _resolve_storage_path(cls, value: Path | None) -> Path | None:
        if value is None:
            return None
        return (value if value.is_absolute() else BACKEND_DIR / value).resolve()

    @field_validator("secret_key", "nvidia_api_key", mode="before")
    @classmethod
    def _blank_is_unset(cls, value: object) -> object:
        # An empty `KEY=` line in .env means "not configured", not "empty secret".
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @model_validator(mode="after")
    def _safe_storage_settings(self) -> Settings:
        if self.storage_max_file_bytes > self.storage_department_quota_bytes:
            raise ValueError("The storage file limit cannot exceed the department quota")

        root = self.storage_root
        filesystem_root = Path(root.anchor)
        if root in (filesystem_root, BACKEND_DIR) or root in BACKEND_DIR.parents:
            raise ValueError("NEXUS_STORAGE_ROOT must be a dedicated directory")

        backup = self.storage_backup_root
        if backup is not None and (
            backup == root or backup in root.parents or root in backup.parents
        ):
            raise ValueError("The storage and backup roots must be separate directory trees")

        for label, configured in (
            ("voice", self.voice_dir),
            ("runs", self.runs_dir),
            ("apps", self.apps_dir),
        ):
            reserved = (
                configured if configured.is_absolute() else BACKEND_DIR / configured
            ).resolve()
            if reserved == root or reserved in root.parents or root in reserved.parents:
                raise ValueError(f"The storage root must not overlap the {label} data directory")
        return self

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
