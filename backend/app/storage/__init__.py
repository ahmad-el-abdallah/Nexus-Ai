"""Digital Vault foundations shared by storage services and APIs."""

from app.storage.names import (
    MAX_LOGICAL_PATH_CHARS,
    MAX_LOGICAL_SEGMENT_CHARS,
    StorageNameError,
    logical_path,
    logical_path_key,
)

__all__ = [
    "MAX_LOGICAL_PATH_CHARS",
    "MAX_LOGICAL_SEGMENT_CHARS",
    "StorageNameError",
    "logical_path",
    "logical_path_key",
]
