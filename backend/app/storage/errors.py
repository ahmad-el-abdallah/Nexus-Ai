"""Expected Digital Vault failures with safe HTTP semantics."""

from __future__ import annotations


class VaultError(Exception):
    """An operation failed without exposing private filesystem details."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


class BlobMissingError(Exception):
    """A metadata row refers to a blob that is not present."""


class BlobUnsafeError(Exception):
    """A blob key or its filesystem representation is unsafe."""


class BlobLimitError(Exception):
    """A streamed upload exceeded its allowed byte count."""
