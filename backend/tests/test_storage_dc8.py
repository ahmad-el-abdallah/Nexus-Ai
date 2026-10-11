from __future__ import annotations

import io
import json
import os
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError
from sqlalchemy import event, select, update

from app.models import Employee, StorageEvent, StorageGrant, StorageVersion
from app.storage.errors import VaultError
from app.storage.insights import VaultInsights
from app.storage.service import StorageActor, VaultService

ENGINEERING = "ws_department:engineering"
MARKETING = "ws_department:marketing"


@dataclass
class Site:
    """One running app with its own Vault and backup folders."""

    http: httpx.AsyncClient
    app: FastAPI
    storage: Path
    backups: Path

    @property
    def vault(self) -> VaultService:
        return self.app.state.vault

    def session(self) -> Any:
        return self.app.state.db.sessionmaker()

    async def upload(
        self, name: str, content: bytes, *, workspace: str = ENGINEERING, parent: str | None = None
    ) -> dict[str, Any]:
        response = await self.http.post(
            f"/api/storage/workspaces/{workspace}/files",
            data={"parent_id": parent} if parent else None,
            files={"file": (name, content, "text/plain")},
        )
        assert response.status_code == 201, response.text
        return response.json()

    async def blob(self, entry_id: str, number: int = 1) -> Path:
        async with self.session() as session:
            key = await session.scalar(
                select(StorageVersion.storage_key).where(
                    StorageVersion.entry_id == entry_id, StorageVersion.number == number
                )
            )
        assert key is not None
        return self.storage / key

    async def backup(self) -> dict[str, Any]:
        response = await self.http.post("/api/storage/backups")
        assert response.status_code == 201, response.text
        return response.json()

    def backup_blob(self, content: bytes) -> Path:
        digest = sha256(content).hexdigest()
        return self.backups / "blobs" / digest[:2] / digest


@pytest.fixture
async def site(
    tmp_path: Path, migrated_db_url: str, make_settings: Any, make_client: Any
) -> AsyncIterator[Site]:
    settings = make_settings(
        NEXUS_DATABASE_URL=migrated_db_url,
        NEXUS_STORAGE_ROOT=tmp_path / "storage",
        NEXUS_STORAGE_BACKUP_ROOT=tmp_path / "backups",
        NEXUS_STORAGE_BACKUP_KEEP=2,
    )
    wrapper = make_client(settings)
    async with wrapper as http:
        yield Site(http, wrapper.app, tmp_path / "storage", tmp_path / "backups")


def reader(content: bytes) -> Callable[[int], Awaitable[bytes]]:
    stream = io.BytesIO(content)

    async def read(size: int) -> bytes:
        return stream.read(size)

    return read


async def employee(site: Site, department: str) -> StorageActor:
    async with site.session() as session:
        person = await session.scalar(select(Employee).where(Employee.department == department))
        assert person is not None
        return await site.vault.actor_for_employee(session, person.id)


async def test_backup_copies_verifies_and_reports_truthfully(site: Site) -> None:
    first, second, other = b"plan v1\n", b"plan v2\n", b"company handbook\n"
    plan = await site.upload("plan.txt", first)
    added = await site.http.post(
        f"/api/storage/entries/{plan['id']}/versions",
        files={"file": ("plan.txt", second, "text/plain")},
    )
    assert added.status_code == 201, added.text
    await site.upload("handbook.txt", other, workspace="ws_company")

    before = (await site.http.get("/api/storage/backups")).json()
    assert before["configured"] is True and before["snapshots"] == []
    assert before["last_backup_at"] is None and before["keep"] == 2
    assert before["same_device"] is True  # both folders are under one temporary directory

    created = await site.backup()
    assert created["status"] == "complete"
    assert (created["files"], created["versions"], created["skipped_versions"]) == (2, 3, 0)
    assert created["bytes"] == len(first) + len(second) + len(other)
    for content in (first, second, other):
        assert site.backup_blob(content).read_bytes() == content

    manifest = json.loads((site.backups / "snapshots" / f"{created['id']}.json").read_text())
    assert manifest["format"] == "nexus-vault-backup/1"
    assert {row["path"] for row in manifest["entries"]} == {"plan.txt", "handbook.txt"}
    assert all("storage_key" not in row for row in manifest["versions"])
    assert str(site.backups) not in json.dumps(created) and "objects/" not in json.dumps(created)

    listed = (await site.http.get("/api/storage/backups")).json()
    assert [row["id"] for row in listed["snapshots"]] == [created["id"]]
    assert listed["snapshots"][0]["verified_ok"] is None
    assert str(site.backups) not in json.dumps(listed)
    overview = (await site.http.get("/api/storage/overview")).json()
    assert overview["backup_configured"] is True and overview["backup_snapshot_count"] == 1
    assert overview["last_backup_at"] is not None and overview["unavailable_version_count"] == 0

    verified = (await site.http.post(f"/api/storage/backups/{created['id']}/verify")).json()
    assert (verified["healthy"], verified["checked"], verified["ok"]) == (True, 3, 3)
    listed = (await site.http.get("/api/storage/backups")).json()
    assert listed["snapshots"][0]["verified_ok"] is True

    # Nothing changed, so the next snapshot stores no content a second time.
    again = await site.backup()
    async with site.session() as session:
        events = list(
            await session.scalars(
                select(StorageEvent)
                .where(StorageEvent.kind == "backup_created")
                .order_by(StorageEvent.id)
            )
        )
    assert [e.details["copied_blobs"] for e in events] == [3, 0]
    assert events[1].details["reused_blobs"] == 3 and events[1].level == "info"

    # A damaged backup is reported as damaged, never as healthy.
    site.backup_blob(second).write_bytes(b"plan XX\n")
    damaged = (await site.http.post(f"/api/storage/backups/{again['id']}/verify")).json()
    assert (damaged["healthy"], damaged["corrupt"], damaged["ok"]) == (False, 1, 2)
    listed = (await site.http.get("/api/storage/backups")).json()
    assert {row["id"]: row["verified_ok"] for row in listed["snapshots"]} == {
        again["id"]: False,
        created["id"]: True,
    }

    # So is one whose manifest was edited after it was written.
    path = site.backups / "snapshots" / f"{created['id']}.json"
    path.write_text(path.read_text().replace("plan.txt", "plot.txt"))
    listed = (await site.http.get("/api/storage/backups")).json()
    assert listed["snapshots"][1]["status"] == "unreadable"
    tampered = (await site.http.post(f"/api/storage/backups/{created['id']}/verify")).json()
    assert tampered["healthy"] is False and tampered["manifest_ok"] is False


async def test_backups_need_configuration_and_the_owner(
    client: httpx.AsyncClient, site: Site
) -> None:
    status = (await client.get("/api/storage/backups")).json()
    assert status == {
        "configured": False,
        "same_device": None,
        "keep": 7,
        "last_backup_at": None,
        "snapshots": [],
    }
    refused = await client.post("/api/storage/backups")
    assert refused.status_code == 409 and "NEXUS_STORAGE_BACKUP_ROOT" in refused.json()["detail"]
    assert (await client.post("/api/storage/maintenance/repair")).status_code == 409
    overview = (await client.get("/api/storage/overview")).json()
    assert overview["backup_configured"] is False and overview["last_backup_at"] is None

    engineer = await employee(site, "engineering")
    backup = site.app.state.backup
    async with site.session() as session:
        for call in (
            backup.status(session, actor=engineer),
            backup.create(session, actor=engineer),
            backup.repair(session, actor=engineer),
            site.vault.cleanup(session, actor=engineer),
            site.vault.integrity(session, actor=engineer),
        ):
            with pytest.raises(VaultError) as refusal:
                await call
            assert refusal.value.status == 403
    assert not (site.backups / "snapshots").exists() or not list(
        (site.backups / "snapshots").iterdir()
    )

    # Only one backup operation runs at a time.
    async with backup._lock:
        busy = await site.http.post("/api/storage/backups")
    assert busy.status_code == 409 and "already running" in busy.json()["detail"]

    assert (await site.http.post("/api/storage/backups/bkp_nope/verify")).status_code == 404
    unknown = "bkp_20200101T000000000000Z_00000000"
    assert (await site.http.post(f"/api/storage/backups/{unknown}/verify")).status_code == 404
    assert (await site.http.get(f"/api/storage/backups/{unknown}/deleted")).status_code == 404


def test_the_number_of_kept_backups_is_validated(make_settings: Any) -> None:
    with pytest.raises(ValidationError):
        make_settings(NEXUS_STORAGE_BACKUP_KEEP=0)


async def test_lost_and_corrupt_content_is_repaired_from_backup(site: Site) -> None:
    first, second, other = b"draft one\n", b"draft two\n", b"budget,1\n"
    draft = await site.upload("draft.txt", first)
    await site.http.post(
        f"/api/storage/entries/{draft['id']}/versions",
        files={"file": ("draft.txt", second, "text/plain")},
    )
    budget = await site.upload("budget.csv", other)
    await site.backup()
    late = await site.upload("late.txt", b"written after the backup\n")

    (await site.blob(draft["id"], 2)).unlink()
    (await site.blob(budget["id"])).write_bytes(b"budget,9\n")
    (await site.blob(late["id"])).unlink()
    assert (await site.http.get(f"/api/storage/entries/{draft['id']}/download")).status_code == 409

    repaired = (await site.http.post("/api/storage/maintenance/repair")).json()
    assert repaired == {"examined": 3, "repaired": 2, "not_in_backup": 1, "failed": 0}
    download = f"/api/storage/entries/{draft['id']}/download"
    assert (await site.http.get(download)).content == second
    assert (await site.http.get(download, params={"version": 1})).content == first
    assert (await site.http.get(f"/api/storage/entries/{budget['id']}/download")).content == other

    # What the backup never held stays honestly unavailable.
    integrity = (await site.http.get("/api/storage/maintenance/integrity")).json()
    assert integrity["damaged_total"] == 1
    assert integrity["damaged"] == [
        {
            "entry_id": late["id"],
            "workspace_id": ENGINEERING,
            "name": "late.txt",
            "path": "late.txt",
            "version": 1,
            "is_current": True,
            "status": "missing",
            "size_bytes": len(b"written after the backup\n"),
        }
    ]
    assert integrity["last_check"]["missing"] == 2 and integrity["last_check"]["corrupt"] == 1
    assert (await site.http.get(f"/api/storage/entries/{late['id']}/download")).status_code == 409
    overview = (await site.http.get("/api/storage/overview")).json()
    assert overview["unavailable_version_count"] == 1
    assert overview["integrity_checked_at"] is not None

    detail = (await site.http.get(f"/api/storage/entries/{draft['id']}")).json()
    assert detail["status"] == "available"
    assert "Recovered version 2 of draft.txt from backup." in [e["text"] for e in detail["events"]]

    # A backup taken now says plainly that one version could not be saved.
    partial = await site.backup()
    assert (partial["status"], partial["skipped_versions"]) == ("partial", 1)
    again = (await site.http.post("/api/storage/maintenance/repair")).json()
    assert again == {"examined": 1, "repaired": 0, "not_in_backup": 1, "failed": 0}


async def test_a_permanently_deleted_file_is_recovered_as_a_new_file(site: Site) -> None:
    content = b"Q3 campaign report\n"
    folder = (
        await site.http.post(
            f"/api/storage/workspaces/{MARKETING}/folders",
            json={"name": "Reports", "parent_id": None},
        )
    ).json()
    report = await site.upload("report.txt", content, workspace=MARKETING, parent=folder["id"])
    kept = await site.upload("kept.txt", b"still here\n", workspace=MARKETING)
    snapshot = (await site.backup())["id"]

    deleted = f"/api/storage/backups/{snapshot}/deleted"
    assert (await site.http.get(deleted)).json() == {"id": snapshot, "total": 0, "items": []}
    assert (await site.http.delete(f"/api/storage/entries/{report['id']}")).status_code == 200
    removed = await site.http.delete(
        f"/api/storage/entries/{report['id']}/permanent", params={"confirm": "true"}
    )
    assert removed.status_code == 200, removed.text

    listed = (await site.http.get(deleted)).json()
    assert listed["total"] == 1
    assert listed["items"] == [
        {
            "entry_id": report["id"],
            "workspace_id": MARKETING,
            "name": "report.txt",
            "path": "Reports/report.txt",
            "version": 1,
            "size_bytes": len(content),
            "recoverable": True,
            "present_at": None,
        }
    ]

    recover = f"/api/storage/backups/{snapshot}/recover"
    recovered = await site.http.post(recover, json={"entry_id": report["id"]})
    assert recovered.status_code == 201, recovered.text
    assert recovered.json()["path"] == "Recovered from backup/report.txt"
    assert recovered.json()["id"] != report["id"]
    new_id = recovered.json()["id"]
    assert (await site.http.get(f"/api/storage/entries/{new_id}/download")).content == content
    detail = (await site.http.get(f"/api/storage/entries/{new_id}")).json()
    assert detail["description"] == (
        f"Recovered from backup {snapshot}. Original location: Reports/report.txt."
    )

    # The list now says where the content is, so it is not recovered twice by mistake.
    assert (await site.http.get(deleted)).json()["items"][0]["present_at"] == (
        "Recovered from backup/report.txt"
    )

    # Recovering again adds a second copy with its full content; nothing is replaced.
    second = await site.http.post(recover, json={"entry_id": report["id"]})
    assert second.status_code == 201 and second.json()["name"] == "report (2).txt"
    assert (
        await site.http.get(f"/api/storage/entries/{second.json()['id']}/download")
    ).content == content

    still_there = await site.http.post(recover, json={"entry_id": kept["id"]})
    assert still_there.status_code == 409 and "still exists" in still_there.json()["detail"]
    assert (await site.http.post(recover, json={"entry_id": "ste_unknown"})).status_code == 404
    assert (await site.http.post(recover, json={"entry_id": folder["id"]})).status_code == 404

    # A backup copy that no longer matches its checksum is refused, not restored.
    site.backup_blob(content).write_bytes(b"Q3 campaign rep0rt\n")
    spoiled = await site.http.post(recover, json={"entry_id": report["id"]})
    assert spoiled.status_code == 409 and "failed verification" in spoiled.json()["detail"]


async def test_retention_keeps_the_newest_backups_and_what_they_need(site: Site) -> None:
    old, new = b"old file\n", b"new file\n"
    first = await site.upload("old.txt", old)
    one = await site.backup()
    await site.upload("new.txt", new)
    two = await site.backup()
    assert (two["pruned_snapshots"], two["pruned_blobs"]) == (0, 0)

    await site.http.delete(f"/api/storage/entries/{first['id']}")
    await site.http.delete(f"/api/storage/entries/{first['id']}/permanent?confirm=true")
    three = await site.backup()
    assert (three["pruned_snapshots"], three["pruned_blobs"]) == (1, 0)
    listed = (await site.http.get("/api/storage/backups")).json()["snapshots"]
    assert [row["id"] for row in listed] == [three["id"], two["id"]]
    assert not (site.backups / "snapshots" / f"{one['id']}.json").exists()
    assert site.backup_blob(old).exists()  # the second backup still needs it

    four = await site.backup()
    assert (four["pruned_snapshots"], four["pruned_blobs"], four["pruned_bytes"]) == (
        1,
        1,
        len(old),
    )
    assert not site.backup_blob(old).exists() and site.backup_blob(new).exists()
    verified = (await site.http.post(f"/api/storage/backups/{four['id']}/verify")).json()
    assert verified["healthy"] is True and verified["checked"] == 1


async def test_cleanup_removes_only_old_objects_nothing_refers_to(site: Site) -> None:
    kept = await site.upload("kept.txt", b"referenced\n")
    old_orphan = site.storage / "objects" / "ab" / ("ab" + "0" * 30)
    new_orphan = site.storage / "objects" / "cd" / ("cd" + "1" * 30)
    old_part = site.storage / "tmp" / "old.part"
    new_part = site.storage / "tmp" / "new.part"
    two_hours_ago = time.time() - 7200
    for path, age in (
        (old_orphan, two_hours_ago),
        (new_orphan, None),
        (old_part, two_hours_ago),
        (new_part, None),
    ):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"left behind")
        if age is not None:
            os.utime(path, (age, age))
    os.utime(await site.blob(kept["id"]), (two_hours_ago, two_hours_ago))

    checked = (await site.http.post("/api/storage/maintenance/reconcile")).json()
    assert checked["orphaned"] == 2 and checked["missing"] == 0

    cleanup = "/api/storage/maintenance/cleanup"
    assert (await site.http.post(cleanup, json={})).status_code == 422
    assert (await site.http.post(cleanup, json={"confirm": False})).status_code == 422
    assert old_orphan.exists()

    cleaned = await site.http.post(cleanup, json={"confirm": True})
    assert cleaned.status_code == 200, cleaned.text
    assert cleaned.json() == {
        "removed_objects": 1,
        "removed_bytes": len(b"left behind"),
        "removed_temporary": 1,
        "kept_recent": 1,
        "unsafe": 0,
    }
    assert not old_orphan.exists() and not old_part.exists()
    assert new_orphan.exists() and new_part.exists()
    download = await site.http.get(f"/api/storage/entries/{kept['id']}/download")
    assert download.content == b"referenced\n"
    assert (await site.http.post("/api/storage/maintenance/reconcile")).json()["orphaned"] == 1


async def test_sharing_is_scoped_listed_and_enforced_on_every_read_path(site: Site) -> None:
    vault, insights = site.vault, VaultInsights(site.vault)
    marketer = await employee(site, "marketing")
    async with site.session() as session:
        plans = await vault.create_folder(session, ENGINEERING, "Plans", None)
        secret = await vault.upload(
            session, ENGINEERING, "secret.txt", "text/plain", reader(b"one\n"), plans["id"], None
        )
        await vault.add_version(
            session, secret["id"], "secret.txt", "text/plain", reader(b"one\ntwo\n"), None
        )
        other = await vault.upload(
            session, ENGINEERING, "other.txt", "text/plain", reader(b"private\n"), None, None
        )

        async def search(actor: StorageActor, **options: Any) -> dict[str, Any]:
            return await vault.search(
                session,
                workspace_id=options.pop("workspace_id", ENGINEERING),
                query=None,
                kind=None,
                tag=None,
                trashed=False,
                sort="name",
                descending=False,
                offset=0,
                limit=50,
                actor=actor,
                **options,
            )

        async def compare(actor: StorageActor) -> dict[str, Any]:
            return await insights.diff(
                session,
                before_entry=secret["id"],
                before_version=1,
                after_entry=secret["id"],
                after_version=2,
                actor=actor,
            )

        reads: dict[str, Callable[[], Awaitable[Any]]] = {
            "detail": lambda: vault.entry_detail(session, secret["id"], actor=marketer),
            "download": lambda: vault.download(session, secret["id"], actor=marketer),
            "preview": lambda: vault.version_content(
                session, secret["id"], limit=1024, actor=marketer
            ),
            "export": lambda: vault.export_zip(session, [secret["id"]], actor=marketer),
            "compare": lambda: compare(marketer),
            "list": lambda: vault.entries(
                session, ENGINEERING, plans["id"], trashed=False, actor=marketer
            ),
            "links": lambda: vault.links(session, secret["id"], actor=marketer),
        }
        for name, read in reads.items():
            with pytest.raises(VaultError) as refusal:
                await read()
            assert refusal.value.status == 403, name
        with pytest.raises(VaultError) as hidden:
            await search(marketer)
        assert hidden.value.status == 404
        board = await insights.dashboard(session, actor=marketer)
        assert ENGINEERING not in {row["id"] for row in board["workspaces"]}

        grant = await vault.grant_access(
            session,
            ENGINEERING,
            grantee_kind="department",
            grantee_id="marketing",
            permission="read",
            entry_id=plans["id"],
        )
        for name, read in reads.items():
            result = await read()
            if name in {"download", "export"}:
                await result.stream.aclose()
        assert (await compare(marketer))["added"] == 1

        # The grant covers the folder, not its neighbours, and reading is not writing.
        writes: list[Callable[[], Awaitable[Any]]] = [
            lambda: vault.entry_detail(session, other["id"], actor=marketer),
            lambda: vault.download(session, other["id"], actor=marketer),
            lambda: vault.trash(session, secret["id"], actor=marketer),
            lambda: vault.update_entry(session, secret["id"], name="mine.txt", actor=marketer),
            lambda: vault.add_version(
                session,
                secret["id"],
                "secret.txt",
                "text/plain",
                reader(b"changed\n"),
                None,
                actor=marketer,
            ),
            lambda: vault.grant_access(
                session,
                ENGINEERING,
                grantee_kind="department",
                grantee_id="sales",
                permission="read",
                entry_id=plans["id"],
                actor=marketer,
            ),
            lambda: vault.active_grants(session, entry_id=secret["id"], actor=marketer),
            lambda: vault.revoke_grant(session, grant["id"], actor=marketer),
        ]
        for write in writes:
            with pytest.raises(VaultError) as refusal:
                await write()
            assert refusal.value.status == 403
        assert await vault.active_grants(session, actor=marketer) == []

        reaching = await vault.active_grants(session, entry_id=secret["id"])
        assert len(reaching) == 1
        assert reaching[0]["id"] == grant["id"] and reaching[0]["inherited"] is True
        assert (reaching[0]["grantee_name"], reaching[0]["entry_name"]) == ("Marketing", "Plans")
        assert await vault.active_grants(session, entry_id=other["id"]) == []
        own = await vault.active_grants(session, entry_id=plans["id"])
        assert [row["inherited"] for row in own] == [False]
        shared = await search(StorageActor(kind="owner", name="Owner"), shared=True)
        assert [row["id"] for row in shared["items"]] == [plans["id"]]

        with pytest.raises(VaultError) as own_department:
            await vault.grant_access(
                session,
                ENGINEERING,
                grantee_kind="department",
                grantee_id="engineering",
                permission="read",
            )
        assert own_department.value.status == 422

        # An expired grant stops working without anyone revoking it.
        await session.execute(
            update(StorageGrant)
            .where(StorageGrant.id == grant["id"])
            .values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        await session.commit()
        for name, read in reads.items():
            with pytest.raises(VaultError) as refusal:
                await read()
            assert refusal.value.status == 403, name
        assert await vault.active_grants(session) == []
        assert (await search(StorageActor(kind="owner", name="Owner"), shared=True))["total"] == 0

        await vault.trash(session, plans["id"])
        with pytest.raises(VaultError) as trashed:
            await vault.grant_access(
                session,
                ENGINEERING,
                grantee_kind="department",
                grantee_id="marketing",
                permission="read",
                entry_id=plans["id"],
            )
        assert trashed.value.status == 409


async def test_the_sharing_api_lists_grants_with_names(site: Site) -> None:
    brief = await site.upload("brief.txt", b"launch brief\n")
    created = await site.http.post(
        f"/api/storage/workspaces/{ENGINEERING}/grants",
        json={
            "grantee_kind": "department",
            "grantee_id": "marketing",
            "permission": "read",
            "entry_id": brief["id"],
        },
    )
    assert created.status_code == 201, created.text
    listed = (await site.http.get("/api/storage/grants")).json()
    assert len(listed) == 1
    assert listed[0] == {
        **created.json(),
        "grantee_name": "Marketing",
        "entry_name": "brief.txt",
        "entry_path": "brief.txt",
        "entry_kind": "file",
        "inherited": False,
    }
    for_item = await site.http.get("/api/storage/grants", params={"entry_id": brief["id"]})
    assert [row["id"] for row in for_item.json()] == [created.json()["id"]]
    assert (
        await site.http.get("/api/storage/grants", params={"entry_id": "ste_missing"})
    ).status_code == 404
    found = (
        await site.http.get(
            "/api/storage/search", params={"workspace_id": ENGINEERING, "shared": "true"}
        )
    ).json()
    assert [row["id"] for row in found["items"]] == [brief["id"]]

    assert (
        await site.http.delete(f"/api/storage/grants/{created.json()['id']}")
    ).status_code == 200
    assert (await site.http.get("/api/storage/grants")).json() == []
    assert (await site.http.get("/api/storage/overview")).json()["active_grant_count"] == 0


async def test_listing_many_files_takes_the_same_few_queries(site: Site) -> None:
    vault = site.vault
    statements: list[str] = []
    engine = site.app.state.db.engine.sync_engine

    def count(_conn: Any, _cursor: Any, statement: str, *_rest: Any) -> None:
        statements.append(statement)

    async def measure(call: Callable[[], Awaitable[Any]]) -> tuple[int, Any]:
        statements.clear()
        result = await call()
        return len(statements), result

    async with site.session() as session:
        folder = await vault.create_folder(session, ENGINEERING, "Many", None)

        async def add(start: int, stop: int) -> None:
            for index in range(start, stop):
                entry = await vault.upload(
                    session,
                    ENGINEERING,
                    f"file-{index:03}.txt",
                    "text/plain",
                    reader(f"content {index}\n".encode()),
                    folder["id"],
                    None,
                )
                await vault.update_entry(
                    session, entry["id"], name=None, tags=["bulk", f"n{index}"]
                )

        def listing() -> Awaitable[Any]:
            return vault.entries(session, ENGINEERING, folder["id"], trashed=False)

        def searching() -> Awaitable[Any]:
            return vault.search(
                session,
                workspace_id=ENGINEERING,
                query="file-",
                kind="file",
                tag=None,
                trashed=False,
                sort="name",
                descending=False,
                offset=0,
                limit=100,
            )

        await add(0, 5)
        event.listen(engine, "before_cursor_execute", count)
        try:
            few_list, _ = await measure(listing)
            few_search, _ = await measure(searching)
            event.remove(engine, "before_cursor_execute", count)
            await add(5, 60)
            event.listen(engine, "before_cursor_execute", count)
            many_list, items = await measure(listing)
            many_search, found = await measure(searching)
        finally:
            if event.contains(engine, "before_cursor_execute", count):
                event.remove(engine, "before_cursor_execute", count)

        assert (many_list, many_search) == (few_list, few_search)
        assert many_list <= 6 and many_search <= 10
        assert len(items) == 60 and found["total"] == 60
        # The batched views are exactly the single-item views.
        for item in (items[0], items[37], items[59]):
            entry = await vault._entry(session, item["id"])
            assert item == await vault.entry_view(session, entry)
        assert items[37]["tags"] == ["bulk", "n37"] and items[37]["size_bytes"] == len(
            b"content 37\n"
        )
