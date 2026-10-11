"""Symlink-resistant, immutable local blob storage."""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import stat
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from app.storage.errors import BlobLimitError, BlobMissingError, BlobUnsafeError

CHUNK_BYTES = 1024 * 1024
KEY_PATTERN = re.compile(r"objects/[0-9a-f]{2}/[0-9a-f]{32}\Z")
Reader = Callable[[int], Awaitable[bytes]]


@dataclass(frozen=True)
class StoredBlob:
    key: str
    size: int
    sha256: str


class LocalBlobStore:
    """Stores immutable objects below one private, configured root."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.objects = self.root / "objects"
        self.temporary = self.root / "tmp"

    async def initialize(self) -> None:
        await asyncio.to_thread(self._initialize_sync)

    def _initialize_sync(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        for directory in (self.root, self.objects, self.temporary):
            if directory.exists() and directory.is_symlink():
                raise BlobUnsafeError("The storage directory cannot be a symbolic link.")
            directory.mkdir(mode=0o700, exist_ok=True)

    def _path(self, key: str) -> Path:
        if not KEY_PATTERN.fullmatch(key):
            raise BlobUnsafeError("The stored object key is invalid.")
        path = self.root.joinpath(*key.split("/"))
        if self.root not in path.parents:
            raise BlobUnsafeError("The stored object key leaves the storage root.")
        current = self.root
        for segment in key.split("/"):
            current /= segment
            if current.is_symlink():
                raise BlobUnsafeError("Symbolic links are not allowed in the blob store.")
        return path

    async def put(self, reader: Reader, limit: int) -> StoredBlob:
        """Stream one blob to a temporary file, then atomically publish it."""
        await self.initialize()
        token = uuid4().hex
        key = f"objects/{token[:2]}/{token}"
        destination = self._path(key)
        await asyncio.to_thread(destination.parent.mkdir, 0o700, True, True)
        if destination.parent.is_symlink():
            raise BlobUnsafeError("Symbolic links are not allowed in the blob store.")
        temporary = self.temporary / f"{uuid4().hex}.part"
        handle = await asyncio.to_thread(temporary.open, "xb")
        digest = hashlib.sha256()
        size = 0
        try:
            while chunk := await reader(CHUNK_BYTES):
                size += len(chunk)
                if size > limit:
                    raise BlobLimitError
                digest.update(chunk)
                await asyncio.to_thread(handle.write, chunk)
            await asyncio.to_thread(handle.flush)
            await asyncio.to_thread(os.fsync, handle.fileno())
            await asyncio.to_thread(handle.close)
            handle = None
            if destination.exists() or destination.is_symlink():
                raise BlobUnsafeError("The generated storage key already exists.")
            await asyncio.to_thread(os.replace, temporary, destination)
            return StoredBlob(key=key, size=size, sha256=digest.hexdigest())
        except BaseException:
            if handle is not None:
                await asyncio.to_thread(handle.close)
            await asyncio.to_thread(temporary.unlink, True)
            raise

    async def remove(self, key: str) -> None:
        path = self._path(key)
        if path.exists():
            await asyncio.to_thread(path.unlink)

    async def clone(self, key: str, limit: int) -> StoredBlob:
        """Create a new immutable object from an existing safe object."""
        source = self.chunks(key)

        async def read(_size: int) -> bytes:
            try:
                return await anext(source)
            except StopAsyncIteration:
                return b""

        try:
            return await self.put(read, limit)
        finally:
            await source.aclose()

    async def checksum(self, key: str) -> tuple[int, str]:
        path = self._path(key)
        try:
            descriptor = await asyncio.to_thread(self._open_readonly, path)
        except FileNotFoundError as error:
            raise BlobMissingError from error
        digest = hashlib.sha256()
        size = 0
        try:
            while chunk := await asyncio.to_thread(os.read, descriptor, CHUNK_BYTES):
                size += len(chunk)
                digest.update(chunk)
        finally:
            await asyncio.to_thread(os.close, descriptor)
        return size, digest.hexdigest()

    async def chunks(self, key: str) -> AsyncIterator[bytes]:
        path = self._path(key)
        try:
            descriptor = await asyncio.to_thread(self._open_readonly, path)
        except FileNotFoundError as error:
            raise BlobMissingError from error
        try:
            while chunk := await asyncio.to_thread(os.read, descriptor, CHUNK_BYTES):
                yield chunk
        finally:
            await asyncio.to_thread(os.close, descriptor)

    @staticmethod
    def _open_readonly(path: Path) -> int:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            os.close(descriptor)
            raise BlobUnsafeError("Stored content is not a regular file.")
        return descriptor

    async def inventory(self) -> tuple[set[str], int]:
        keys, unsafe = await asyncio.to_thread(self._inventory_sync)
        return set(keys), unsafe

    async def inventory_details(self) -> tuple[dict[str, tuple[int, float]], int]:
        """Every safe object key with its size and modification time, and the unsafe count."""
        return await asyncio.to_thread(self._inventory_sync)

    async def clear_temporary(self, before: float) -> int:
        """Remove interrupted upload fragments last written before the given time."""

        def clear() -> int:
            removed = 0
            if not self.temporary.is_dir():
                return removed
            for item in self.temporary.iterdir():
                try:
                    info = item.lstat()
                    if stat.S_ISREG(info.st_mode) and info.st_mtime < before:
                        item.unlink()
                        removed += 1
                except OSError:
                    continue
            return removed

        return await asyncio.to_thread(clear)

    def _inventory_sync(self) -> tuple[dict[str, tuple[int, float]], int]:
        keys: dict[str, tuple[int, float]] = {}
        unsafe = 0
        if not self.objects.exists():
            return keys, unsafe
        for directory, names, files in os.walk(self.objects, followlinks=False):
            base = Path(directory)
            safe_names: list[str] = []
            for name in names:
                candidate = base / name
                if candidate.is_symlink():
                    unsafe += 1
                else:
                    safe_names.append(name)
            names[:] = safe_names
            for name in files:
                candidate = base / name
                key = candidate.relative_to(self.root).as_posix()
                if candidate.is_symlink() or not KEY_PATTERN.fullmatch(key):
                    unsafe += 1
                    continue
                try:
                    info = candidate.stat()
                except OSError:
                    continue  # removed while the inventory was being taken
                keys[key] = (info.st_size, info.st_mtime)
        return keys, unsafe
