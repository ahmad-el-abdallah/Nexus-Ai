"""Canonical logical paths for the Digital Vault.

Vault paths are database names, not paths on the server filesystem. Keeping one
strict POSIX representation gives SQLite and PostgreSQL the same uniqueness
semantics and prevents a later local-storage backend from mistaking user input
for an operating-system path.
"""

from __future__ import annotations

import ntpath
import unicodedata

MAX_LOGICAL_PATH_CHARS = 1024
MAX_LOGICAL_SEGMENT_CHARS = 255


class StorageNameError(ValueError):
    """A logical Vault path is not safe or canonical."""


def logical_path(value: str) -> str:
    """Return the case-preserving NFKC form of a safe relative POSIX path."""
    if not isinstance(value, str):
        raise StorageNameError("A storage path must be text.")
    path = unicodedata.normalize("NFKC", value)
    if not path:
        raise StorageNameError("A storage path cannot be empty.")
    if "\x00" in path:
        raise StorageNameError("A storage path cannot contain NUL characters.")
    if "\\" in path:
        raise StorageNameError("Storage paths use '/' separators, not backslashes.")
    if path.startswith("//"):
        raise StorageNameError("UNC paths are not storage paths.")
    if path.startswith("/"):
        raise StorageNameError("A storage path must be relative.")
    drive, _ = ntpath.splitdrive(path)
    if drive:
        raise StorageNameError("Drive-qualified paths are not storage paths.")
    if len(path) > MAX_LOGICAL_PATH_CHARS:
        raise StorageNameError(f"A storage path cannot exceed {MAX_LOGICAL_PATH_CHARS} characters.")

    segments = path.split("/")
    if any(not segment for segment in segments):
        raise StorageNameError("A storage path cannot contain empty segments.")
    if any(segment in {".", ".."} for segment in segments):
        raise StorageNameError("A storage path cannot contain '.' or '..' segments.")
    if any(len(segment) > MAX_LOGICAL_SEGMENT_CHARS for segment in segments):
        raise StorageNameError(
            f"A storage path segment cannot exceed {MAX_LOGICAL_SEGMENT_CHARS} characters."
        )
    return path


def logical_path_key(value: str) -> str:
    """Case-insensitive uniqueness key for a logical path."""
    key = logical_path(value).casefold()
    # Case-folding can expand characters (for example, 'ß' becomes 'ss').
    if len(key) > MAX_LOGICAL_PATH_CHARS:
        raise StorageNameError(
            f"A storage path's comparison key cannot exceed {MAX_LOGICAL_PATH_CHARS} characters."
        )
    return key


def logical_name(value: str) -> str:
    """Return one safe, canonical path segment."""
    name = logical_path(value)
    if "/" in name:
        raise StorageNameError("A storage name cannot contain path separators.")
    return name
