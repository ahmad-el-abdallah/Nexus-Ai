"""Guards against committing credentials or hardcoded email addresses."""

from __future__ import annotations

import os
import re
from collections.abc import Iterator
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

SKIP_DIRS = {
    ".git",
    "node_modules",
    ".venv",
    ".next",
    "var",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
    "coverage",
    ".artifacts",
    "design-references",
}
SKIP_FILES = {".env"}  # local, gitignored; holds the generated secret key by design

SECRET_PATTERNS = {
    "NVIDIA API key": re.compile(r"nvapi-[A-Za-z0-9_\-]{20,}"),
    "OpenAI-style key": re.compile(r"\bsk-[A-Za-z0-9]{20,}"),
    "Private key block": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "AWS access key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}"),
    "Google API key": re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b"),
    "Slack token": re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
}
EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@([A-Za-z0-9\-]+\.)+[A-Za-z]{2,}")
ALLOWED_EMAIL_DOMAINS = ("example.com", "example.org", "example.net")


def _text_files() -> Iterator[tuple[Path, str]]:
    for dirpath, dirnames, filenames in os.walk(REPO_ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]  # prune, don't descend
        for name in filenames:
            if name in SKIP_FILES:
                continue
            path = Path(dirpath, name)
            try:
                yield path, path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue  # binary file


def test_scan_covers_the_repository() -> None:
    scanned = {p.relative_to(REPO_ROOT).as_posix() for p, _ in _text_files()}
    assert "backend/app/main.py" in scanned
    assert "backend/.env.example" in scanned


def test_no_hardcoded_credentials() -> None:
    findings = [
        f"{path.relative_to(REPO_ROOT)}: {label}"
        for path, content in _text_files()
        for label, pattern in SECRET_PATTERNS.items()
        if pattern.search(content)
    ]
    assert findings == []


def test_no_hardcoded_email_addresses() -> None:
    findings = [
        f"{path.relative_to(REPO_ROOT)}: {match.group(0)}"
        for path, content in _text_files()
        for match in EMAIL.finditer(content)
        if not match.group(0).lower().endswith(ALLOWED_EMAIL_DOMAINS)
    ]
    assert findings == []
