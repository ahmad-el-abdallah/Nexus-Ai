"""Structured logging with secret redaction.

Every log record passes through ``redact_secrets`` before rendering, so API
keys, tokens and passwords are masked even if a caller logs them by mistake.
"""

from __future__ import annotations

import logging
import re
import sys
from collections.abc import Mapping
from typing import Any

import structlog

REDACTED = "[REDACTED]"

_SENSITIVE_KEY = re.compile(
    r"(api[_-]?key|token|secret|password|passwd|authorization|cookie|credential|private[_-]?key)",
    re.IGNORECASE,
)
_SENSITIVE_VALUE = re.compile(
    r"(nvapi-[A-Za-z0-9_\-]{8,}"
    r"|sk-[A-Za-z0-9_\-]{16,}"
    r"|gh[pousr]_[A-Za-z0-9]{20,}"
    r"|AKIA[0-9A-Z]{16}"
    r"|ya29\.[A-Za-z0-9_\-]+"
    r"|Bearer\s+[A-Za-z0-9._\-]+)"
)


def _scrub(value: Any) -> Any:
    if isinstance(value, str):
        return _SENSITIVE_VALUE.sub(REDACTED, value)
    if isinstance(value, Mapping):
        return {k: _scrub_item(k, v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return type(value)(_scrub(v) for v in value)
    return value


def _scrub_item(key: Any, value: Any) -> Any:
    # Flags such as `secret_key_present=True` carry no secret; everything else
    # under a sensitive-looking key is masked wholesale.
    if isinstance(key, str) and _SENSITIVE_KEY.search(key) and not isinstance(value, bool | None):
        return REDACTED
    return _scrub(value)


def redact_secrets(_logger: Any, _method: str, event_dict: dict[str, Any]) -> dict[str, Any]:
    """structlog processor: mask sensitive keys and secret-looking values."""
    return _scrub(event_dict)


def configure_logging(level: str = "INFO", fmt: str = "console") -> None:
    shared: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.format_exc_info,
        redact_secrets,
    ]
    renderer: structlog.types.Processor = (
        structlog.processors.JSONRenderer()
        if fmt == "json"
        else structlog.dev.ConsoleRenderer(colors=sys.stderr.isatty())
    )

    structlog.configure(
        processors=[*shared, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    handler = logging.StreamHandler()
    handler.setFormatter(
        structlog.stdlib.ProcessorFormatter(
            foreign_pre_chain=shared,
            processors=[structlog.stdlib.ProcessorFormatter.remove_processors_meta, renderer],
        )
    )
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())

    # Route uvicorn's loggers through the same pipeline; our middleware logs requests.
    for name in ("uvicorn", "uvicorn.error"):
        logging.getLogger(name).handlers.clear()
        logging.getLogger(name).propagate = True
    logging.getLogger("uvicorn.access").disabled = True
    # Readiness checks inspect migration state on every call; keep that quiet.
    logging.getLogger("alembic.runtime.migration").setLevel(logging.WARNING)


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    return structlog.stdlib.get_logger(name)
