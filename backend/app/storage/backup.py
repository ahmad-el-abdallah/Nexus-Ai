"""Verified snapshots of the Digital Vault and recovery from them.

A snapshot is one manifest (the Vault's metadata at that moment) plus the bytes of every
stored version, kept by checksum so unchanged files are stored once across snapshots.
Nothing here deletes or overwrites live Vault content: recovery only adds what is missing.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.models import (
    StorageEntry,
    StorageEntryKind,
    StorageEvent,
    StorageLink,
    StorageTag,
    StorageVersion,
    StorageVersionStatus,
    StorageWorkspace,
)
from app.storage.errors import BlobLimitError, BlobMissingError, BlobUnsafeError, VaultError
from app.storage.local import CHUNK_BYTES, LocalBlobStore
from app.storage.service import OWNER_ACTOR, StorageActor, VaultService

FORMAT = "nexus-vault-backup/1"
# The microsecond timestamp makes snapshot names sort in the order they were created.
SNAPSHOT_ID = re.compile(r"bkp_(\d{8}T\d{12})Z_[0-9a-f]{8}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
MAX_MANIFEST_BYTES = 64 * 1024 * 1024
MAX_LISTED = 500
RECOVERY_FOLDER = "Recovered from backup"


class BackupMismatchError(Exception):
    """Bytes read for a backup did not match the recorded size and checksum."""


def _stamp(value: datetime | None) -> str | None:
    return value.astimezone(UTC).isoformat() if value else None


class BackupStore:
    """The backup folder: content-addressed blobs and one manifest per snapshot."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.blobs = self.root / "blobs"
        self.snapshots = self.root / "snapshots"
        self.temporary = self.root / "tmp"

    async def initialize(self) -> None:
        await asyncio.to_thread(self._initialize_sync)

    def _initialize_sync(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        for directory in (self.root, self.blobs, self.snapshots, self.temporary):
            if directory.is_symlink():
                raise BlobUnsafeError("The backup directory cannot be a symbolic link.")
            directory.mkdir(mode=0o700, exist_ok=True)

    def same_device(self, other: Path) -> bool | None:
        """Whether the backups live on the same drive as the Vault (None: unknown)."""
        try:
            return os.stat(self.root).st_dev == os.stat(other).st_dev
        except OSError:
            return None

    def _blob(self, sha256: str) -> Path:
        if not SHA256.fullmatch(sha256):
            raise BlobUnsafeError("The backup object name is invalid.")
        folder = self.blobs / sha256[:2]
        path = folder / sha256
        if folder.is_symlink() or path.is_symlink():
            raise BlobUnsafeError("Symbolic links are not allowed in the backup store.")
        return path

    def _manifest(self, snapshot_id: str) -> Path:
        if not SNAPSHOT_ID.fullmatch(snapshot_id):
            raise VaultError(404, "Backup not found.")
        path = self.snapshots / f"{snapshot_id}.json"
        if path.is_symlink():
            raise BlobUnsafeError("Symbolic links are not allowed in the backup store.")
        return path

    async def has(self, sha256: str, size: int) -> bool:
        path = self._blob(sha256)

        def check() -> bool:
            try:
                return path.is_file() and path.stat().st_size == size
            except OSError:
                return False

        return await asyncio.to_thread(check)

    async def put(self, sha256: str, size: int, source: AsyncIterator[bytes]) -> None:
        """Copy one object in, publishing it only if it matches its size and checksum."""
        destination = self._blob(sha256)
        await asyncio.to_thread(destination.parent.mkdir, 0o700, True, True)
        temporary = self.temporary / f"{uuid4().hex}.part"
        handle = await asyncio.to_thread(temporary.open, "xb")
        digest = hashlib.sha256()
        written = 0
        try:
            async for chunk in source:
                written += len(chunk)
                if written > size:
                    raise BackupMismatchError
                digest.update(chunk)
                await asyncio.to_thread(handle.write, chunk)
            if written != size or digest.hexdigest() != sha256:
                raise BackupMismatchError
            await asyncio.to_thread(handle.flush)
            await asyncio.to_thread(os.fsync, handle.fileno())
            await asyncio.to_thread(handle.close)
            handle = None
            await asyncio.to_thread(os.replace, temporary, destination)
        except BaseException:
            if handle is not None:
                await asyncio.to_thread(handle.close)
            await asyncio.to_thread(temporary.unlink, True)
            raise

    async def checksum(self, sha256: str) -> tuple[int, str]:
        digest = hashlib.sha256()
        size = 0
        async for chunk in self.chunks(sha256):
            size += len(chunk)
            digest.update(chunk)
        return size, digest.hexdigest()

    async def chunks(self, sha256: str) -> AsyncIterator[bytes]:
        path = self._blob(sha256)
        try:
            descriptor = await asyncio.to_thread(LocalBlobStore._open_readonly, path)
        except FileNotFoundError as error:
            raise BlobMissingError from error
        try:
            while chunk := await asyncio.to_thread(os.read, descriptor, CHUNK_BYTES):
                yield chunk
        finally:
            await asyncio.to_thread(os.close, descriptor)

    async def write_manifest(self, snapshot_id: str, document: dict[str, Any]) -> None:
        path = self._manifest(snapshot_id)
        data = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        checksum = hashlib.sha256(data).hexdigest()

        def write() -> None:
            for target, content in (
                (path, data),
                (path.with_suffix(".sha256"), checksum.encode("ascii")),
            ):
                temporary = self.temporary / f"{uuid4().hex}.part"
                with temporary.open("xb") as handle:
                    handle.write(content)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, target)

        await asyncio.to_thread(write)

    async def read_manifest(self, snapshot_id: str) -> dict[str, Any] | None:
        """The manifest, or None when it is absent, altered or not a NEXUS manifest."""
        path = self._manifest(snapshot_id)

        def read() -> dict[str, Any] | None:
            try:
                if path.stat().st_size > MAX_MANIFEST_BYTES:
                    return None
                data = path.read_bytes()
                recorded = path.with_suffix(".sha256").read_text("ascii").strip()
            except (OSError, UnicodeDecodeError):
                return None
            if hashlib.sha256(data).hexdigest() != recorded:
                return None
            try:
                document = json.loads(data)
            except ValueError:
                return None
            if not isinstance(document, dict) or document.get("format") != FORMAT:
                return None
            return document

        return await asyncio.to_thread(read)

    async def snapshot_ids(self) -> list[str]:
        """Newest first; the timestamp in the name makes the order chronological."""

        def names() -> list[str]:
            if not self.snapshots.is_dir():
                return []
            found = [
                item.stem
                for item in self.snapshots.iterdir()
                if item.suffix == ".json" and SNAPSHOT_ID.fullmatch(item.stem)
            ]
            return sorted(found, reverse=True)

        return await asyncio.to_thread(names)

    async def remove_snapshot(self, snapshot_id: str) -> None:
        path = self._manifest(snapshot_id)

        def remove() -> None:
            path.unlink(missing_ok=True)
            path.with_suffix(".sha256").unlink(missing_ok=True)

        await asyncio.to_thread(remove)

    async def prune_blobs(self, keep: set[str]) -> tuple[int, int]:
        """Remove stored objects that no remaining snapshot refers to."""

        def prune() -> tuple[int, int]:
            removed = freed = 0
            if not self.blobs.is_dir():
                return removed, freed
            for folder in self.blobs.iterdir():
                if folder.is_symlink() or not folder.is_dir():
                    continue
                for item in folder.iterdir():
                    if item.is_symlink() or not SHA256.fullmatch(item.name) or item.name in keep:
                        continue
                    size = item.stat().st_size
                    item.unlink()
                    removed += 1
                    freed += size
            return removed, freed

        return await asyncio.to_thread(prune)


class VaultBackup:
    """Creates, verifies and restores from snapshots. Only the owner may use it."""

    def __init__(self, vault: VaultService, settings: Settings) -> None:
        self.vault = vault
        self.settings = settings
        root = settings.storage_backup_root
        self.store = BackupStore(root) if root is not None else None
        self._lock = asyncio.Lock()

    def _configured(self, actor: StorageActor) -> BackupStore:
        if actor.kind not in {"owner", "system"}:
            raise VaultError(403, "Only the owner can manage Vault backups.")
        if self.store is None:
            raise VaultError(
                409,
                "Backups are not configured. Set NEXUS_STORAGE_BACKUP_ROOT to a folder "
                "outside the Vault storage folder and restart NEXUS.",
            )
        return self.store

    def _exclusive(self) -> asyncio.Lock:
        if self._lock.locked():
            raise VaultError(409, "Another backup operation is already running.")
        return self._lock

    async def brief(self) -> tuple[int, datetime | None]:
        """How many snapshots exist and when the newest was taken, without reading them."""
        if self.store is None:
            return 0, None
        ids = await self.store.snapshot_ids()
        return len(ids), (self._unreadable(ids[0])["created_at"] if ids else None)

    async def status(
        self, session: AsyncSession, *, actor: StorageActor = OWNER_ACTOR
    ) -> dict[str, Any]:
        if actor.kind not in {"owner", "system"}:
            raise VaultError(403, "Only the owner can manage Vault backups.")
        result: dict[str, Any] = {
            "configured": self.store is not None,
            "same_device": None,
            "keep": self.settings.storage_backup_keep,
            "last_backup_at": None,
            "snapshots": [],
        }
        if self.store is None:
            return result
        await self.store.initialize()
        result["same_device"] = self.store.same_device(self.settings.storage_root)
        verified: dict[str, StorageEvent] = {}
        events = await session.scalars(
            select(StorageEvent)
            .where(StorageEvent.kind == "backup_verified")
            .order_by(StorageEvent.created_at.desc(), StorageEvent.id.desc())
            .limit(200)
        )
        for event in events:
            verified.setdefault(str(event.details.get("snapshot_id")), event)
        for snapshot_id in await self.store.snapshot_ids():
            manifest = await self.store.read_manifest(snapshot_id)
            check = verified.get(snapshot_id)
            if manifest is None:
                summary = self._unreadable(snapshot_id)
            else:
                summary = self._summary(manifest)
                if result["last_backup_at"] is None:
                    result["last_backup_at"] = summary["created_at"]
            summary["verified_at"] = check.created_at if check else None
            summary["verified_ok"] = (
                not (check.details.get("missing") or check.details.get("corrupt"))
                and bool(check.details.get("manifest_ok"))
                if check
                else None
            )
            result["snapshots"].append(summary)
        return result

    async def create(
        self, session: AsyncSession, *, actor: StorageActor = OWNER_ACTOR
    ) -> dict[str, Any]:
        store = self._configured(actor)
        async with self._exclusive():
            try:
                await store.initialize()
                manifest = await self._snapshot(session, store)
                await store.write_manifest(manifest["id"], manifest)
            except OSError as error:
                await session.rollback()
                session.add(
                    StorageEvent(
                        level="error",
                        kind="backup_failed",
                        actor_kind=actor.kind,
                        actor_name=actor.name,
                        text="A Vault backup could not be written.",
                        details={"reason": error.strerror or type(error).__name__},
                    )
                )
                await session.commit()
                raise VaultError(
                    507, f"The backup could not be written: {error.strerror or 'storage error'}."
                ) from error
            totals = manifest["totals"]
            pruned = await self._prune(store)
            session.add(
                StorageEvent(
                    level="warn" if totals["skipped_versions"] else "info",
                    kind="backup_created",
                    actor_kind=actor.kind,
                    actor_name=actor.name,
                    text=(
                        f"Backed up {totals['versions'] - totals['skipped_versions']} of "
                        f"{totals['versions']} stored file versions."
                    ),
                    details={"snapshot_id": manifest["id"], **totals, **pruned},
                )
            )
            await session.commit()
            return {**self._summary(manifest), "verified_at": None, "verified_ok": None, **pruned}

    async def _snapshot(self, session: AsyncSession, store: BackupStore) -> dict[str, Any]:
        workspaces = list(
            await session.scalars(select(StorageWorkspace).order_by(StorageWorkspace.id))
        )
        entries = list(
            await session.scalars(
                select(StorageEntry).order_by(StorageEntry.workspace_id, StorageEntry.path)
            )
        )
        versions = list(
            await session.scalars(
                select(StorageVersion).order_by(StorageVersion.entry_id, StorageVersion.number)
            )
        )
        tags: dict[str, list[str]] = {}
        for tag in await session.scalars(select(StorageTag).order_by(StorageTag.tag)):
            tags.setdefault(tag.entry_id, []).append(tag.tag)
        links = list(await session.scalars(select(StorageLink).order_by(StorageLink.id)))

        outcome: dict[tuple[str, int], str | None] = {}
        copied = reused = stored_bytes = 0
        version_rows: list[dict[str, Any]] = []
        for version in versions:
            key = (version.sha256, version.size_bytes)
            if key not in outcome:
                if await store.has(*key):
                    outcome[key] = None
                    reused += 1
                else:
                    try:
                        await store.put(*key, self.vault.blobs.chunks(version.storage_key))
                        outcome[key] = None
                        copied += 1
                    except BlobMissingError:
                        outcome[key] = "The stored content is missing."
                    except (BlobUnsafeError, BackupMismatchError):
                        outcome[key] = "The stored content failed integrity validation."
                if outcome[key] is None:
                    stored_bytes += version.size_bytes
            version_rows.append(
                {
                    "id": version.id,
                    "entry_id": version.entry_id,
                    "number": version.number,
                    "original_name": version.original_name,
                    "mime_type": version.mime_type,
                    "size_bytes": version.size_bytes,
                    "sha256": version.sha256,
                    "change_description": version.change_description,
                    "created_by_kind": version.created_by_kind,
                    "created_by_name": version.created_by_name,
                    "created_at": _stamp(version.created_at),
                    "stored": outcome[key] is None,
                    "reason": outcome[key],
                }
            )
        created_at = datetime.now(UTC)
        skipped = sum(1 for row in version_rows if not row["stored"])
        return {
            "format": FORMAT,
            "id": f"bkp_{created_at:%Y%m%dT%H%M%S%f}Z_{uuid4().hex[:8]}",
            "created_at": _stamp(created_at),
            "status": "partial" if skipped else "complete",
            "totals": {
                "entries": len(entries),
                "files": sum(1 for entry in entries if entry.kind == StorageEntryKind.FILE.value),
                "versions": len(versions),
                "bytes": stored_bytes,
                "copied_blobs": copied,
                "reused_blobs": reused,
                "skipped_versions": skipped,
            },
            "workspaces": [
                {
                    "id": workspace.id,
                    "scope": workspace.scope,
                    "department_key": workspace.department_key,
                    "state": workspace.state,
                    "quota_bytes": workspace.quota_bytes,
                }
                for workspace in workspaces
            ],
            "entries": [
                {
                    "id": entry.id,
                    "workspace_id": entry.workspace_id,
                    "parent_id": entry.parent_id,
                    "kind": entry.kind,
                    "name": entry.name,
                    "path": entry.path,
                    "description": entry.description,
                    "artifact_type": entry.artifact_type,
                    "visibility": entry.visibility,
                    "status": entry.status,
                    "current_version_number": entry.current_version_number,
                    "created_by_kind": entry.created_by_kind,
                    "created_by_name": entry.created_by_name,
                    "owner_kind": entry.owner_kind,
                    "owner_id": entry.owner_id,
                    "owner_name": entry.owner_name,
                    "tags": tags.get(entry.id, []),
                    "trashed_at": _stamp(entry.trashed_at),
                    "created_at": _stamp(entry.created_at),
                    "updated_at": _stamp(entry.updated_at),
                }
                for entry in entries
            ],
            "versions": version_rows,
            "links": [
                {
                    "entry_id": link.entry_id,
                    "version_id": link.version_id,
                    "target_type": link.target_type,
                    "target_id": link.target_id,
                    "relation": link.relation,
                    "label": link.label,
                }
                for link in links
            ],
        }

    async def _prune(self, store: BackupStore) -> dict[str, int]:
        """Keep the newest snapshots; drop objects only when every manifest is readable."""
        ids = await store.snapshot_ids()
        removed = 0
        for snapshot_id in ids[self.settings.storage_backup_keep :]:
            await store.remove_snapshot(snapshot_id)
            removed += 1
        keep: set[str] = set()
        for snapshot_id in ids[: self.settings.storage_backup_keep]:
            manifest = await store.read_manifest(snapshot_id)
            if manifest is None:
                # An unreadable manifest may still need its objects: remove nothing.
                return {"pruned_snapshots": removed, "pruned_blobs": 0, "pruned_bytes": 0}
            keep.update(str(row["sha256"]) for row in manifest["versions"])
        blobs, freed = await store.prune_blobs(keep)
        return {"pruned_snapshots": removed, "pruned_blobs": blobs, "pruned_bytes": freed}

    async def verify(
        self, session: AsyncSession, snapshot_id: str, *, actor: StorageActor = OWNER_ACTOR
    ) -> dict[str, Any]:
        store = self._configured(actor)
        async with self._exclusive():
            await store.initialize()
            if snapshot_id not in await store.snapshot_ids():
                raise VaultError(404, "Backup not found.")
            manifest = await store.read_manifest(snapshot_id)
            checked = ok = missing = corrupt = 0
            if manifest is not None:
                wanted = {
                    (str(row["sha256"]), int(row["size_bytes"]))
                    for row in manifest["versions"]
                    if row["stored"]
                }
                for sha256, size in sorted(wanted):
                    checked += 1
                    try:
                        if await store.checksum(sha256) == (size, sha256):
                            ok += 1
                        else:
                            corrupt += 1
                    except BlobMissingError:
                        missing += 1
                    except BlobUnsafeError:
                        corrupt += 1
            details = {
                "snapshot_id": snapshot_id,
                "manifest_ok": manifest is not None,
                "checked": checked,
                "ok": ok,
                "missing": missing,
                "corrupt": corrupt,
            }
            healthy = manifest is not None and not missing and not corrupt
            event = StorageEvent(
                level="info" if healthy else "error",
                kind="backup_verified",
                actor_kind=actor.kind,
                actor_name=actor.name,
                text=(
                    f"Verified backup {snapshot_id}: every stored object matches its checksum."
                    if healthy
                    else f"Backup {snapshot_id} failed verification."
                ),
                details=details,
            )
            session.add(event)
            await session.commit()
            await session.refresh(event)
            return {
                **details,
                "id": snapshot_id,
                "healthy": healthy,
                "verified_at": event.created_at,
            }

    async def repair(
        self, session: AsyncSession, *, actor: StorageActor = OWNER_ACTOR
    ) -> dict[str, int]:
        """Put back, from the backups, the content of versions the Vault has lost."""
        store = self._configured(actor)
        async with self._exclusive():
            await store.initialize()
            await self.vault.reconcile(session)
            damaged = list(
                await session.scalars(
                    select(StorageVersion)
                    .where(StorageVersion.status != StorageVersionStatus.AVAILABLE.value)
                    .order_by(StorageVersion.entry_id, StorageVersion.number)
                )
            )
            repaired = not_in_backup = failed = 0
            for version in damaged:
                if not await store.has(version.sha256, version.size_bytes):
                    not_in_backup += 1
                    continue
                source = store.chunks(version.sha256)

                async def read(_size: int, source: AsyncIterator[bytes] = source) -> bytes:
                    try:
                        return await anext(source)
                    except StopAsyncIteration:
                        return b""

                try:
                    blob = await self.vault.blobs.put(read, version.size_bytes)
                except (BlobLimitError, BlobMissingError, BlobUnsafeError, OSError):
                    failed += 1
                    continue
                finally:
                    await source.aclose()
                if (blob.size, blob.sha256) != (version.size_bytes, version.sha256):
                    await self.vault.blobs.remove(blob.key)
                    failed += 1
                    continue
                entry = await session.get(StorageEntry, version.entry_id)
                version.storage_key = blob.key
                version.status = StorageVersionStatus.AVAILABLE.value
                if entry is not None and entry.current_version_number == version.number:
                    entry.status = StorageVersionStatus.AVAILABLE.value
                    entry.last_error = None
                session.add(
                    StorageEvent(
                        workspace_id=entry.workspace_id if entry else None,
                        entry_id=version.entry_id,
                        version_id=version.id,
                        level="info",
                        kind="version_recovered",
                        actor_kind=actor.kind,
                        actor_name=actor.name,
                        text=(
                            f"Recovered version {version.number} of "
                            f"{entry.name if entry else 'a file'} from backup."
                        ),
                        details={"size_bytes": version.size_bytes},
                    )
                )
                try:
                    await session.commit()
                except BaseException:
                    await session.rollback()
                    await self.vault.blobs.remove(blob.key)
                    raise
                repaired += 1
            return {
                "examined": len(damaged),
                "repaired": repaired,
                "not_in_backup": not_in_backup,
                "failed": failed,
            }

    async def deleted_files(
        self, session: AsyncSession, snapshot_id: str, *, actor: StorageActor = OWNER_ACTOR
    ) -> dict[str, Any]:
        """Files this snapshot holds that no longer exist in the Vault."""
        store = self._configured(actor)
        manifest = await self._manifest(store, snapshot_id)
        live = set(await session.scalars(select(StorageEntry.id)))
        current = self._current_versions(manifest)
        deleted = [
            entry
            for entry in manifest["entries"]
            if entry["kind"] == StorageEntryKind.FILE.value
            and entry["id"] not in live
            and entry["id"] in current
        ]
        listed = deleted[:MAX_LISTED]
        # Where the same content already is in the same workspace (for example because
        # it was recovered earlier), so the owner is not invited to recover it twice.
        present: dict[tuple[str, str], str] = {}
        checksums = {str(current[entry["id"]]["sha256"]) for entry in listed}
        if checksums:
            rows = await session.execute(
                select(StorageEntry.workspace_id, StorageVersion.sha256, StorageEntry.path)
                .join(
                    StorageVersion,
                    (StorageVersion.entry_id == StorageEntry.id)
                    & (StorageVersion.number == StorageEntry.current_version_number),
                )
                .where(StorageVersion.sha256.in_(checksums), StorageEntry.trashed_at.is_(None))
                .order_by(StorageEntry.path)
            )
            for workspace_id, sha256, path in rows:
                present.setdefault((workspace_id, sha256), path)
        items = [
            {
                "entry_id": entry["id"],
                "workspace_id": entry["workspace_id"],
                "name": entry["name"],
                "path": entry["path"],
                "version": entry["current_version_number"],
                "size_bytes": current[entry["id"]]["size_bytes"],
                "recoverable": bool(current[entry["id"]]["stored"]),
                "present_at": present.get(
                    (entry["workspace_id"], str(current[entry["id"]]["sha256"]))
                ),
            }
            for entry in listed
        ]
        return {"id": snapshot_id, "total": len(deleted), "items": items}

    async def recover(
        self,
        session: AsyncSession,
        snapshot_id: str,
        entry_id: str,
        *,
        actor: StorageActor = OWNER_ACTOR,
    ) -> dict[str, Any]:
        """Re-create a deleted file's newest content as a new file; nothing is replaced."""
        store = self._configured(actor)
        async with self._exclusive():
            manifest = await self._manifest(store, snapshot_id)
            entry = next(
                (
                    row
                    for row in manifest["entries"]
                    if row["id"] == entry_id and row["kind"] == StorageEntryKind.FILE.value
                ),
                None,
            )
            version = self._current_versions(manifest).get(entry_id)
            if entry is None or version is None:
                raise VaultError(404, "This backup does not contain that file.")
            if await session.get(StorageEntry, entry_id) is not None:
                raise VaultError(409, "This file still exists in the Vault.")
            if not version["stored"]:
                raise VaultError(409, "This backup does not hold that file's content.")
            sha256, size = str(version["sha256"]), int(version["size_bytes"])
            try:
                intact = await store.checksum(sha256) == (size, sha256)
            except (BlobMissingError, BlobUnsafeError):
                intact = False
            if not intact:
                raise VaultError(409, "The backup copy of this file failed verification.")
            workspace_id = str(entry["workspace_id"])
            folder_id = await self._recovery_folder(session, workspace_id, actor)
            name = str(entry["name"])
            stem, suffix = Path(name).stem, Path(name).suffix
            for attempt in range(1, 100):
                # A fresh reader per attempt: a refused name must not consume the content.
                source = store.chunks(sha256)

                async def read(_size: int, source: AsyncIterator[bytes] = source) -> bytes:
                    try:
                        return await anext(source)
                    except StopAsyncIteration:
                        return b""

                try:
                    return await self.vault.upload(
                        session,
                        workspace_id,
                        name if attempt == 1 else f"{stem} ({attempt}){suffix}",
                        str(version["mime_type"]),
                        read,
                        folder_id,
                        f"Recovered from backup {snapshot_id}. Original location: {entry['path']}.",
                        actor=actor,
                    )
                except VaultError as error:
                    if error.status != 409 or "already exists" not in error.detail:
                        raise
                finally:
                    await source.aclose()
            raise VaultError(409, "Too many recovered copies of this file already exist.")

    async def _recovery_folder(
        self, session: AsyncSession, workspace_id: str, actor: StorageActor
    ) -> str:
        existing = await session.scalar(
            select(StorageEntry).where(
                StorageEntry.workspace_id == workspace_id,
                StorageEntry.parent_id.is_(None),
                StorageEntry.name == RECOVERY_FOLDER,
                StorageEntry.kind == StorageEntryKind.FOLDER.value,
                StorageEntry.trashed_at.is_(None),
            )
        )
        if existing is not None:
            return existing.id
        folder = await self.vault.create_folder(
            session, workspace_id, RECOVERY_FOLDER, None, actor=actor
        )
        return str(folder["id"])

    async def _manifest(self, store: BackupStore, snapshot_id: str) -> dict[str, Any]:
        await store.initialize()
        if snapshot_id not in await store.snapshot_ids():
            raise VaultError(404, "Backup not found.")
        manifest = await store.read_manifest(snapshot_id)
        if manifest is None:
            raise VaultError(409, "This backup's manifest is unreadable or was altered.")
        return manifest

    @staticmethod
    def _current_versions(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
        numbers = {row["id"]: row["current_version_number"] for row in manifest["entries"]}
        return {
            row["entry_id"]: row
            for row in manifest["versions"]
            if numbers.get(row["entry_id"]) == row["number"]
        }

    @staticmethod
    def _summary(manifest: dict[str, Any]) -> dict[str, Any]:
        totals = manifest["totals"]
        return {
            "id": manifest["id"],
            "created_at": datetime.fromisoformat(manifest["created_at"]),
            "status": manifest["status"],
            "files": totals["files"],
            "versions": totals["versions"],
            "bytes": totals["bytes"],
            "skipped_versions": totals["skipped_versions"],
        }

    @staticmethod
    def _unreadable(snapshot_id: str) -> dict[str, Any]:
        # The name carries the time, so it is usually known even when the manifest is not.
        created_at: datetime | None = None
        match = SNAPSHOT_ID.fullmatch(snapshot_id)
        if match:
            try:
                created_at = datetime.strptime(match.group(1), "%Y%m%dT%H%M%S%f").replace(
                    tzinfo=UTC
                )
            except ValueError:
                created_at = None
        return {
            "id": snapshot_id,
            "created_at": created_at,
            "status": "unreadable",
            "files": 0,
            "versions": 0,
            "bytes": 0,
            "skipped_versions": 0,
        }
