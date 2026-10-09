from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from app.core.config import BACKEND_DIR, Environment, StorageBackend


def test_secrets_are_masked_in_repr(make_settings) -> None:
    secret = "nvapi-" + "S" * 30
    settings = make_settings(NVIDIA_API_KEY=secret, NEXUS_SECRET_KEY="k" * 44)
    assert settings.nvidia_api_key is not None
    assert settings.nvidia_api_key.get_secret_value() == secret
    assert secret not in repr(settings)
    assert "k" * 44 not in repr(settings)
    assert secret not in settings.model_dump_json()


def test_blank_secret_means_not_configured(make_settings) -> None:
    settings = make_settings(NVIDIA_API_KEY="   ", NEXUS_SECRET_KEY="")
    assert settings.nvidia_api_key is None
    assert settings.secret_key is None


def test_cors_origins_parse_from_comma_separated_env(monkeypatch, make_settings) -> None:
    monkeypatch.setenv("NEXUS_CORS_ORIGINS", "http://a.test, http://b.test ,")
    settings = make_settings()
    assert settings.cors_origins == ["http://a.test", "http://b.test"]


def test_defaults_are_local_and_safe(make_settings) -> None:
    settings = make_settings()
    assert settings.env is Environment.TEST
    assert settings.host == "127.0.0.1"
    assert settings.database_dialect == "sqlite"
    assert settings.nvidia_base_url.startswith("https://")
    assert settings.storage_backend is StorageBackend.LOCAL
    assert settings.storage_root == (BACKEND_DIR / "var" / "storage").resolve()
    assert settings.storage_max_file_bytes == 100 * 1024 * 1024
    assert settings.storage_department_quota_bytes == 10 * 1024 * 1024 * 1024
    assert settings.storage_backup_root is None
    assert ".pdf" in settings.storage_allowed_extensions


def test_database_dialect_detection(make_settings) -> None:
    settings = make_settings(NEXUS_DATABASE_URL="postgresql+asyncpg://u@localhost/db")
    assert settings.database_dialect == "postgresql"


def test_storage_extensions_parse_and_normalise(make_settings) -> None:
    settings = make_settings(NEXUS_STORAGE_ALLOWED_EXTENSIONS="PDF, .Csv, pdf, tsx")
    assert settings.storage_allowed_extensions == [".pdf", ".csv", ".tsx"]


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"NEXUS_STORAGE_BACKEND": "pretend-s3"}, "NEXUS_STORAGE_BACKEND"),
        ({"NEXUS_STORAGE_ROOT": "  "}, "NEXUS_STORAGE_ROOT cannot be empty"),
        (
            {
                "NEXUS_STORAGE_MAX_FILE_BYTES": 11,
                "NEXUS_STORAGE_DEPARTMENT_QUOTA_BYTES": 10,
            },
            "file limit",
        ),
        ({"NEXUS_STORAGE_ALLOWED_EXTENSIONS": "../exe"}, "storage extension"),
    ],
)
def test_invalid_storage_settings_are_rejected(make_settings, overrides, message) -> None:
    with pytest.raises(ValidationError, match=message):
        make_settings(**overrides)


def test_storage_paths_are_resolved_from_backend(make_settings) -> None:
    settings = make_settings(
        NEXUS_STORAGE_ROOT="var/test-vault",
        NEXUS_STORAGE_BACKUP_ROOT="var/test-vault-backup",
    )
    assert settings.storage_root == (BACKEND_DIR / "var" / "test-vault").resolve()
    assert settings.storage_backup_root == (BACKEND_DIR / "var" / "test-vault-backup").resolve()


@pytest.mark.parametrize(
    ("root", "backup"),
    [
        (BACKEND_DIR, None),
        (Path(BACKEND_DIR.anchor), None),
        (BACKEND_DIR / "var" / "storage", BACKEND_DIR / "var" / "storage" / "backups"),
        (BACKEND_DIR / "var" / "storage", BACKEND_DIR / "var"),
        (BACKEND_DIR / "var" / "apps" / "vault", None),
    ],
)
def test_unsafe_or_overlapping_storage_paths_are_rejected(
    make_settings, root: Path, backup: Path | None
) -> None:
    values = {"NEXUS_STORAGE_ROOT": root}
    if backup is not None:
        values["NEXUS_STORAGE_BACKUP_ROOT"] = backup
    with pytest.raises(ValidationError):
        make_settings(**values)
