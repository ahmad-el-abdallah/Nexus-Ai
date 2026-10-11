"""Read-only views over the Digital Vault: text comparison, engineering projects and
the storage dashboard.

Everything here is derived from rows and bytes that already exist. Nothing is written,
and every read goes through the Vault service's permission and integrity checks.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta, timezone
from difflib import SequenceMatcher
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    App,
    AppFile,
    AppStatus,
    AppVersion,
    Department,
    FileStatus,
    StorageEntry,
    StorageEntryKind,
    StorageEntryStatus,
    StorageEvent,
    StorageLink,
    StorageVersion,
)
from app.storage.errors import VaultError
from app.storage.service import OWNER_ACTOR, StorageActor, VaultService, VersionContent

ENGINEERING_WORKSPACE = "ws_department:engineering"
# Bounds for one comparison: it runs in memory and is sent to the browser.
MAX_DIFF_BYTES = 512 * 1024
MAX_DIFF_LINES = 20_000
MAX_DIFF_OUTPUT = 2_000
MAX_LINE_CHARS = 2_000
CONTEXT_LINES = 3
ACTIVITY_DAYS = 14
ACTIVITY_ROW_LIMIT = 50_000
# Bookkeeping that follows every stored file; it stays in each file's own history.
ROUTINE_EVENT_KINDS = ("artifact_linked", "entry_updated")


def text_lines(content: VersionContent) -> tuple[list[str] | None, str | None]:
    """The lines of a version that can be compared as text, or why it cannot be."""
    if content.preview_kind not in {"text", "csv"}:
        return None, "Only text files can be compared line by line."
    if content.data is None:
        return None, "Files larger than 512 KiB are not compared line by line."
    if b"\x00" in content.data:
        return None, "This file contains binary data."
    lines = content.data.decode("utf-8", errors="replace").splitlines()
    if len(lines) > MAX_DIFF_LINES:
        return None, f"Files with more than {MAX_DIFF_LINES:,} lines are not compared."
    return lines, None


def line_diff(before: list[str], after: list[str]) -> dict[str, Any]:
    """A unified line comparison with line numbers, bounded in size."""

    def clip(text: str) -> str:
        return text if len(text) <= MAX_LINE_CHARS else f"{text[:MAX_LINE_CHARS]}…"

    added = removed = 0
    truncated = False
    lines: list[dict[str, Any]] = []

    def emit(kind: str, old: int | None, new: int | None, text: str) -> None:
        nonlocal truncated
        if len(lines) >= MAX_DIFF_OUTPUT:
            truncated = True
            return
        lines.append({"kind": kind, "old": old, "new": new, "text": clip(text)})

    matcher = SequenceMatcher(None, before, after)
    for group in matcher.get_grouped_opcodes(CONTEXT_LINES):
        first, last = group[0], group[-1]
        emit(
            "hunk",
            None,
            None,
            f"@@ -{first[1] + 1},{last[2] - first[1]} +{first[3] + 1},{last[4] - first[3]} @@",
        )
        for tag, old_start, old_end, new_start, new_end in group:
            if tag == "equal":
                for offset in range(old_end - old_start):
                    emit(
                        "context",
                        old_start + offset + 1,
                        new_start + offset + 1,
                        before[old_start + offset],
                    )
                continue
            removed += old_end - old_start
            added += new_end - new_start
            for index in range(old_start, old_end):
                emit("remove", index + 1, None, before[index])
            for index in range(new_start, new_end):
                emit("add", None, index + 1, after[index])
    return {"added": added, "removed": removed, "truncated": truncated, "lines": lines}


class VaultInsights:
    def __init__(self, vault: VaultService) -> None:
        self.vault = vault

    # ------------------------------------------------------------ comparison

    async def diff(
        self,
        session: AsyncSession,
        *,
        before_entry: str,
        before_version: int | None,
        after_entry: str,
        after_version: int | None,
        actor: StorageActor = OWNER_ACTOR,
    ) -> dict[str, Any]:
        """Compare two stored versions: of one file, or of two different files."""
        before = await self.vault.version_content(
            session, before_entry, version_number=before_version, limit=MAX_DIFF_BYTES, actor=actor
        )
        after = await self.vault.version_content(
            session, after_entry, version_number=after_version, limit=MAX_DIFF_BYTES, actor=actor
        )
        result: dict[str, Any] = {
            "before": self._side(before),
            "after": self._side(after),
            "identical": before.sha256 == after.sha256 and before.size == after.size,
            "comparable": True,
            "reason": None,
            "line_endings_only": False,
            "added": 0,
            "removed": 0,
            "truncated": False,
            "lines": [],
        }
        if result["identical"]:
            return result
        before_lines, before_reason = text_lines(before)
        after_lines, after_reason = text_lines(after)
        if before_lines is None or after_lines is None:
            result.update(comparable=False, reason=before_reason or after_reason)
            return result
        result.update(await asyncio.to_thread(line_diff, before_lines, after_lines))
        # The bytes differ but no line does: only line endings or the final newline changed.
        result["line_endings_only"] = not result["added"] and not result["removed"]
        return result

    @staticmethod
    def _side(content: VersionContent) -> dict[str, Any]:
        return {
            "entry_id": content.entry_id,
            "name": content.name,
            "path": content.path,
            "version": content.number,
            "size_bytes": content.size,
            "sha256": content.sha256,
            "created_by_name": content.created_by_name,
            "created_at": content.created_at,
        }

    # ---------------------------------------------------- engineering projects

    async def projects(
        self, session: AsyncSession, *, actor: StorageActor = OWNER_ACTOR
    ) -> list[dict[str, Any]]:
        """Every engineering app with what the Vault really holds for it."""
        await self._require_engineering(session, actor)
        apps = list(await session.scalars(select(App).order_by(App.updated_at.desc(), App.id)))
        versions = list(await session.scalars(select(AppVersion).order_by(AppVersion.number)))
        ready = {v.id for v in versions if v.status == AppStatus.READY.value}
        files = (
            await session.execute(
                select(AppFile.id, AppFile.version_id).where(
                    AppFile.version_id.in_(ready), AppFile.status == FileStatus.WRITTEN.value
                )
            )
        ).all()
        stored = await self._stored(session, [file_id for file_id, _ in files])
        result = []
        for app in apps:
            own = [v for v in versions if v.app_id == app.id]
            own_ids = {v.id for v in own}
            entries = [
                stored[file_id]
                for file_id, version_id in files
                if version_id in own_ids and file_id in stored
            ]
            latest = own[-1] if own else None
            result.append(
                {
                    "id": app.id,
                    "name": app.name,
                    "description": app.description,
                    "current_version": app.current_version,
                    "latest_status": latest.status if latest else None,
                    "version_count": len(own),
                    "ready_version_count": sum(1 for v in own if v.id in ready),
                    "stored_file_count": len(entries),
                    "stored_bytes": sum(entry["size_bytes"] or 0 for entry in entries),
                    "created_at": app.created_at,
                    "updated_at": app.updated_at,
                }
            )
        return result

    async def project(
        self, session: AsyncSession, app_id: str, *, actor: StorageActor = OWNER_ACTOR
    ) -> dict[str, Any]:
        """One app's versions, the stored files of each, and what changed between them."""
        await self._require_engineering(session, actor)
        app = await session.get(App, app_id)
        if app is None:
            raise VaultError(404, "Engineering project not found.")
        versions = list(
            await session.scalars(
                select(AppVersion).where(AppVersion.app_id == app.id).order_by(AppVersion.number)
            )
        )
        ready = {v.number: v for v in versions if v.status == AppStatus.READY.value}
        files: dict[str, list[AppFile]] = {v.id: [] for v in ready.values()}
        for file in await session.scalars(
            select(AppFile)
            .where(AppFile.version_id.in_(list(files)), AppFile.status == FileStatus.WRITTEN.value)
            .order_by(AppFile.position, AppFile.id)
        ):
            files[file.version_id].append(file)
        stored = await self._stored(
            session, [file.id for group in files.values() for file in group]
        )
        views = []
        for version in versions:
            own = files.get(version.id, [])
            base = ready.get(version.base_version) if version.base_version else None
            previous = {file.path: file for file in files.get(base.id, [])} if base else {}
            rows = []
            for file in own:
                entry = stored.get(file.id)
                earlier = previous.get(file.path)
                change = None
                if base is not None:
                    if earlier is None:
                        change = "added"
                    else:
                        change = "modified" if earlier.content != file.content else "unchanged"
                earlier_entry = stored.get(earlier.id) if earlier else None
                rows.append(
                    {
                        "path": file.path,
                        "area": file.area,
                        "purpose": file.purpose,
                        "author_name": file.author_name,
                        "author_role": file.author_role,
                        "entry_id": entry["entry_id"] if entry else None,
                        "state": entry["state"] if entry else "not_stored",
                        "size_bytes": entry["size_bytes"] if entry else None,
                        "sha256": entry["sha256"] if entry else None,
                        "change": change,
                        "previous_entry_id": (
                            earlier_entry["entry_id"]
                            if earlier_entry and earlier_entry["state"] == "available"
                            else None
                        ),
                    }
                )
            views.append(
                {
                    "id": version.id,
                    "number": version.number,
                    "base_version": base.number if base else None,
                    "status": version.status,
                    "request": version.request,
                    "stack": version.stack,
                    "tree_sha256": version.tree_sha256,
                    "finished_at": version.finished_at,
                    "folder_id": await self._version_folder(session, version, own, stored),
                    "stored_file_count": sum(1 for row in rows if row["entry_id"]),
                    "stored_bytes": sum(row["size_bytes"] or 0 for row in rows),
                    "files": rows,
                    "removed": sorted(set(previous) - {file.path for file in own}),
                }
            )
        return {
            "id": app.id,
            "name": app.name,
            "description": app.description,
            "current_version": app.current_version,
            "created_at": app.created_at,
            "updated_at": app.updated_at,
            "versions": views,
        }

    async def _require_engineering(self, session: AsyncSession, actor: StorageActor) -> None:
        readable = {item["id"] for item in await self.vault.workspaces(session, actor=actor)}
        if ENGINEERING_WORKSPACE not in readable:
            raise VaultError(403, "This storage actor does not have the required access.")

    async def _stored(
        self, session: AsyncSession, file_ids: list[int]
    ) -> dict[int, dict[str, Any]]:
        """The Vault file the registrar stored for each app file, by app-file id."""
        if not file_ids:
            return {}
        rows = (
            await session.execute(
                select(StorageLink.target_id, StorageEntry, StorageVersion)
                .join(StorageEntry, StorageEntry.id == StorageLink.entry_id)
                .outerjoin(
                    StorageVersion,
                    (StorageVersion.entry_id == StorageEntry.id)
                    & (StorageVersion.number == StorageEntry.current_version_number),
                )
                .where(
                    StorageLink.target_type == "app_file",
                    StorageLink.relation == "source",
                    StorageLink.target_id.in_([str(file_id) for file_id in file_ids]),
                    StorageEntry.workspace_id == ENGINEERING_WORKSPACE,
                )
                .order_by(StorageLink.created_at, StorageLink.id)
            )
        ).all()
        result: dict[int, dict[str, Any]] = {}
        for target_id, entry, version in rows:
            result[int(target_id)] = {
                "entry_id": entry.id,
                "parent_id": entry.parent_id,
                "state": "trashed" if entry.trashed_at is not None else entry.status,
                "size_bytes": version.size_bytes if version else None,
                "sha256": version.sha256 if version else None,
            }
        return result

    @staticmethod
    async def _version_folder(
        session: AsyncSession,
        version: AppVersion,
        files: list[AppFile],
        stored: dict[int, dict[str, Any]],
    ) -> str | None:
        """The Vault folder that holds this version, when its files are still in place."""
        for file in files:
            entry = stored.get(file.id)
            if entry is None or entry["state"] == "trashed":
                continue
            folder_id = entry["parent_id"]
            for _ in range(file.path.count("/")):
                folder = await session.get(StorageEntry, folder_id) if folder_id else None
                folder_id = folder.parent_id if folder else None
            folder = await session.get(StorageEntry, folder_id) if folder_id else None
            if folder and folder.trashed_at is None and folder.name == f"Version {version.number}":
                return folder.id
            return None
        return None

    # -------------------------------------------------------------- dashboard

    async def dashboard(
        self,
        session: AsyncSession,
        *,
        actor: StorageActor = OWNER_ACTOR,
        utc_offset_minutes: int = 0,
    ) -> dict[str, Any]:
        """Real totals, usage, composition and recent activity for readable workspaces."""
        workspaces = await self.vault.workspaces(session, actor=actor)
        ids = [workspace["id"] for workspace in workspaces]
        names = dict((await session.execute(select(Department.key, Department.name))).all())
        active_file = (
            StorageEntry.workspace_id.in_(ids),
            StorageEntry.kind == StorageEntryKind.FILE.value,
            StorageEntry.trashed_at.is_(None),
        )
        current = (StorageVersion.entry_id == StorageEntry.id) & (
            StorageVersion.number == StorageEntry.current_version_number
        )

        files_by_workspace = dict(
            (
                await session.execute(
                    select(StorageEntry.workspace_id, func.count())
                    .where(*active_file)
                    .group_by(StorageEntry.workspace_id)
                )
            ).all()
        )

        async def count(*conditions: Any) -> int:
            return int(
                await session.scalar(
                    select(func.count())
                    .select_from(StorageEntry)
                    .where(StorageEntry.workspace_id.in_(ids), *conditions)
                )
                or 0
            )

        by_type = (
            await session.execute(
                select(
                    StorageEntry.artifact_type,
                    func.count(StorageEntry.id),
                    func.coalesce(func.sum(StorageVersion.size_bytes), 0),
                )
                .outerjoin(StorageVersion, current)
                .where(*active_file)
                .group_by(StorageEntry.artifact_type)
            )
        ).all()
        by_creator = (
            await session.execute(
                select(StorageEntry.created_by_kind, func.count())
                .where(*active_file)
                .group_by(StorageEntry.created_by_kind)
            )
        ).all()
        creators = (
            await session.execute(
                select(
                    StorageEntry.created_by_employee_id,
                    func.max(StorageEntry.created_by_name),
                    func.count(),
                )
                .where(*active_file, StorageEntry.created_by_employee_id.is_not(None))
                .group_by(StorageEntry.created_by_employee_id)
                .order_by(func.count().desc(), StorageEntry.created_by_employee_id)
                .limit(8)
            )
        ).all()

        # Events without a workspace (such as reconciliation) are the owner's to see.
        visible = StorageEvent.workspace_id.in_(ids)
        if actor.kind in {"owner", "system"}:
            visible = or_(visible, StorageEvent.workspace_id.is_(None))
        # Days are the viewer's calendar days, so the chart agrees with the times shown.
        zone = timezone(timedelta(minutes=utc_offset_minutes))
        today = datetime.now(zone).date()
        first_day = today - timedelta(days=ACTIVITY_DAYS - 1)
        since = datetime.combine(first_day, datetime.min.time(), tzinfo=zone)
        per_day = {
            first_day + timedelta(days=offset): {"events": 0, "errors": 0}
            for offset in range(ACTIVITY_DAYS)
        }
        recent_rows = (
            await session.execute(
                select(StorageEvent.created_at, StorageEvent.level)
                .where(visible, StorageEvent.created_at >= since)
                .order_by(StorageEvent.created_at.desc())
                .limit(ACTIVITY_ROW_LIMIT)
            )
        ).all()
        for created_at, level in recent_rows:
            day = per_day.get(created_at.astimezone(zone).date())
            if day is not None:
                day["events"] += 1
                day["errors"] += level == "error"
        events = list(
            await session.scalars(
                select(StorageEvent)
                .where(visible, StorageEvent.kind.not_in(ROUTINE_EVENT_KINDS))
                .order_by(StorageEvent.created_at.desc(), StorageEvent.id.desc())
                .limit(12)
            )
        )

        async def event_count(*conditions: Any) -> int:
            return int(
                await session.scalar(
                    select(func.count()).select_from(StorageEvent).where(visible, *conditions)
                )
                or 0
            )

        version_count = int(
            await session.scalar(
                select(func.count())
                .select_from(StorageVersion)
                .join(StorageEntry, StorageEntry.id == StorageVersion.entry_id)
                .where(StorageEntry.workspace_id.in_(ids))
            )
            or 0
        )
        projects: dict[str, int] | None = None
        if ENGINEERING_WORKSPACE in ids:
            projects = {
                "apps": int(await session.scalar(select(func.count()).select_from(App)) or 0),
                "ready_versions": int(
                    await session.scalar(
                        select(func.count())
                        .select_from(AppVersion)
                        .where(AppVersion.status == AppStatus.READY.value)
                    )
                    or 0
                ),
                "stored_files": int(
                    await session.scalar(
                        select(func.count(func.distinct(StorageLink.entry_id))).where(
                            StorageLink.target_type == "app_file",
                            StorageLink.relation == "source",
                        )
                    )
                    or 0
                ),
            }
        return {
            "generated_at": datetime.now(UTC),
            "utc_offset_minutes": utc_offset_minutes,
            "totals": {
                "files": await count(
                    StorageEntry.kind == StorageEntryKind.FILE.value,
                    StorageEntry.trashed_at.is_(None),
                ),
                "folders": await count(
                    StorageEntry.kind == StorageEntryKind.FOLDER.value,
                    StorageEntry.trashed_at.is_(None),
                ),
                "trashed": await count(StorageEntry.trashed_at.is_not(None)),
                "versions": version_count,
                "stored_bytes": sum(workspace["used_bytes"] for workspace in workspaces),
                "unavailable_files": await count(
                    StorageEntry.kind == StorageEntryKind.FILE.value,
                    StorageEntry.status != StorageEntryStatus.AVAILABLE.value,
                ),
                "error_events": await event_count(StorageEvent.level == "error"),
                "registration_failures": await event_count(
                    StorageEvent.kind == "artifact_registration_failed"
                ),
            },
            "workspaces": [
                {
                    **workspace,
                    "name": (
                        "Company Vault"
                        if workspace["scope"] == "company"
                        else names.get(workspace["department_key"], workspace["department_key"])
                    ),
                    "file_count": int(files_by_workspace.get(workspace["id"], 0)),
                }
                for workspace in workspaces
            ],
            "by_type": sorted(
                (
                    {"artifact_type": kind, "files": int(files), "bytes": int(size)}
                    for kind, files, size in by_type
                ),
                key=lambda row: (-row["files"], row["artifact_type"] or ""),
            ),
            "by_creator": sorted(
                ({"kind": kind, "files": int(files)} for kind, files in by_creator),
                key=lambda row: (-row["files"], row["kind"]),
            ),
            "top_creators": [
                {"employee_id": employee_id, "name": name, "files": int(files)}
                for employee_id, name, files in creators
            ],
            "activity": [
                {"date": day.isoformat(), **counts} for day, counts in sorted(per_day.items())
            ],
            "recent_events": [
                {
                    "id": event.id,
                    "kind": event.kind,
                    "level": event.level,
                    "actor_name": event.actor_name,
                    "text": event.text,
                    "workspace_id": event.workspace_id,
                    "created_at": event.created_at,
                }
                for event in events
            ],
            "projects": projects,
        }
