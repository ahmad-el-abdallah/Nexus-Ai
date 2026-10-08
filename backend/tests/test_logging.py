from __future__ import annotations

import json
import logging

import pytest

from app.core.logging import REDACTED, configure_logging, get_logger, redact_secrets

FAKE_NVIDIA_KEY = "nvapi-" + "A1b2C3d4" * 4
FAKE_OPENAI_KEY = "sk-" + "Z" * 32


def test_sensitive_keys_are_masked() -> None:
    event = redact_secrets(
        None,
        "info",
        {
            "event": "call",
            "api_key": "anything",
            "Authorization": "Bearer abc",
            "password": "hunter2",
            "nested": {"refresh_token": "r", "safe": "visible"},
        },
    )
    assert event["api_key"] == REDACTED
    assert event["Authorization"] == REDACTED
    assert event["password"] == REDACTED
    assert event["nested"]["refresh_token"] == REDACTED
    assert event["nested"]["safe"] == "visible"


def test_secret_looking_values_are_masked_anywhere() -> None:
    event = redact_secrets(
        None,
        "info",
        {
            "event": f"request failed with key {FAKE_NVIDIA_KEY}",
            "headers": ["Bearer eyJhbGciOi.payload.sig"],
            "note": f"fallback {FAKE_OPENAI_KEY}",
        },
    )
    assert FAKE_NVIDIA_KEY not in event["event"]
    assert REDACTED in event["event"]
    assert event["headers"] == [REDACTED]
    assert FAKE_OPENAI_KEY not in event["note"]


def test_boolean_flags_with_sensitive_names_are_kept() -> None:
    event = redact_secrets(None, "info", {"secret_key_present": True, "api_key": None})
    assert event == {"secret_key_present": True, "api_key": None}


def test_rendered_json_logs_contain_no_secrets(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("INFO", "json")
    get_logger("test").info("provider.error", api_key=FAKE_NVIDIA_KEY, detail=FAKE_NVIDIA_KEY)
    logging.getLogger("stdlib").warning("raw message with %s", FAKE_NVIDIA_KEY)

    output = capsys.readouterr().err
    assert FAKE_NVIDIA_KEY not in output
    lines = [json.loads(line) for line in output.strip().splitlines()]
    assert lines[0]["event"] == "provider.error"
    assert lines[0]["api_key"] == REDACTED
