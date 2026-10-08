from __future__ import annotations

from app.core.config import Environment


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


def test_database_dialect_detection(make_settings) -> None:
    settings = make_settings(NEXUS_DATABASE_URL="postgresql+asyncpg://u@localhost/db")
    assert settings.database_dialect == "postgresql"
