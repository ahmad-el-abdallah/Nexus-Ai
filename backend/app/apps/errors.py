from __future__ import annotations


class AppError(Exception):
    """A request about an app that can't be carried out (shown to the owner as is)."""

    def __init__(self, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.status = status
