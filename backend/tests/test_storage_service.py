from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import select

from app.core.config import Settings
from app.db.session import Database
from app.models import StorageVersion, StorageWorkspace
from app.storage.errors import BlobLimitError
from app.storage.local import LocalBlobStore


@asynccontextmanager
async def storage_client(
    make_settings: Any,
    make_client: Any,
    migrated_db_url: str,
    root: Path,
    **settings: Any,
) -> AsyncIterator[httpx.AsyncClient]:
    configured: Settings = make_settings(
        NEXUS_DATABASE_URL=migrated_db_url,
        NEXUS_STORAGE_ROOT=root,
        **settings,
    )
    async with make_client(configured) as client:
        yield client


async def test_folder_upload_download_move_trash_and_restore_are_real(
    tmp_path: Path, migrated_db_url: str, make_settings: Any, make_client: Any
) -> None:
    content = b"quarterly facts\n"
    async with storage_client(
        make_settings, make_client, migrated_db_url, tmp_path / "storage"
    ) as client:
        folder_response = await client.post(
            "/api/storage/workspaces/ws_department:engineering/folders",
            json={"name": "Reports"},
        )
        assert folder_response.status_code == 201
        folder = folder_response.json()

        upload_response = await client.post(
            "/api/storage/workspaces/ws_department:engineering/files",
            data={"parent_id": folder["id"], "description": "Real source material"},
            files={"file": ("Quarter.TXT", content, "text/plain")},
        )
        assert upload_response.status_code == 201, upload_response.text
        uploaded = upload_response.json()
        assert uploaded["path"] == "Reports/Quarter.TXT"
        assert uploaded["size_bytes"] == len(content)
        assert "storage_key" not in upload_response.text

        download = await client.get(f"/api/storage/entries/{uploaded['id']}/download")
        assert download.status_code == 200
        assert download.content == content
        assert download.headers["x-content-type-options"] == "nosniff"
        assert "Quarter.TXT" in download.headers["content-disposition"]

        renamed = await client.patch(
            f"/api/storage/entries/{folder['id']}", json={"name": "Published"}
        )
        assert renamed.status_code == 200
        children = await client.get(
            "/api/storage/workspaces/ws_department:engineering/entries",
            params={"parent_id": folder["id"]},
        )
        assert children.json()[0]["path"] == "Published/Quarter.TXT"

        trashed = await client.delete(f"/api/storage/entries/{folder['id']}")
        assert trashed.status_code == 200
        assert trashed.json()["trashed_at"] is not None
        assert (
            await client.get(f"/api/storage/entries/{uploaded['id']}/download")
        ).status_code == 404
        trash = await client.get(
            "/api/storage/workspaces/ws_department:engineering/entries",
            params={"trashed": "true"},
        )
        assert {item["id"] for item in trash.json()} == {folder["id"], uploaded["id"]}

        restored = await client.post(f"/api/storage/entries/{folder['id']}/restore")
        assert restored.status_code == 200
        assert restored.json()["trashed_at"] is None
        assert (
            await client.get(f"/api/storage/entries/{uploaded['id']}/download")
        ).content == content

        moved = await client.patch(
            f"/api/storage/entries/{uploaded['id']}",
            json={"name": "Final.txt", "parent_id": None},
        )
        assert moved.status_code == 200
        assert moved.json()["path"] == "Final.txt"

        overview = (await client.get("/api/storage/overview")).json()
        assert overview["writes_enabled"] is True
        assert overview["folder_count"] == overview["file_count"] == 1
        assert overview["stored_bytes"] == len(content)


async def test_upload_validation_size_quota_and_duplicate_cleanup(
    tmp_path: Path, migrated_db_url: str, make_settings: Any, make_client: Any
) -> None:
    root = tmp_path / "storage"
    async with storage_client(
        make_settings,
        make_client,
        migrated_db_url,
        root,
        NEXUS_STORAGE_MAX_FILE_BYTES=12,
        NEXUS_STORAGE_DEPARTMENT_QUOTA_BYTES=15,
    ) as client:
        invalid_name = await client.post(
            "/api/storage/workspaces/ws_company/files",
            files={"file": ("../escape.txt", b"bad", "text/plain")},
        )
        assert invalid_name.status_code == 422
        invalid_extension = await client.post(
            "/api/storage/workspaces/ws_company/files",
            files={"file": ("payload.exe", b"bad", "application/octet-stream")},
        )
        assert invalid_extension.status_code == 415
        too_large = await client.post(
            "/api/storage/workspaces/ws_company/files",
            files={"file": ("large.txt", b"x" * 13, "text/plain")},
        )
        assert too_large.status_code == 413

        first = await client.post(
            "/api/storage/workspaces/ws_company/files",
            files={"file": ("facts.txt", b"x" * 10, "text/plain")},
        )
        assert first.status_code == 201, first.text
        duplicate = await client.post(
            "/api/storage/workspaces/ws_company/files",
            files={"file": ("FACTS.TXT", b"other", "text/plain")},
        )
        assert duplicate.status_code == 409
        over_quota = await client.post(
            "/api/storage/workspaces/ws_company/files",
            files={"file": ("more.txt", b"y" * 6, "text/plain")},
        )
        assert over_quota.status_code == 413

    objects = [path for path in (root / "objects").rglob("*") if path.is_file()]
    temporary = [path for path in (root / "tmp").iterdir() if path.is_file()]
    assert len(objects) == 1
    assert temporary == []


async def test_read_only_workspace_and_folder_cycle_are_enforced(
    tmp_path: Path, migrated_db_url: str, make_settings: Any, make_client: Any
) -> None:
    async with storage_client(
        make_settings, make_client, migrated_db_url, tmp_path / "storage"
    ) as client:
        parent = (
            await client.post(
                "/api/storage/workspaces/ws_department:engineering/folders",
                json={"name": "Parent"},
            )
        ).json()
        child = (
            await client.post(
                "/api/storage/workspaces/ws_department:engineering/folders",
                json={"name": "Child", "parent_id": parent["id"]},
            )
        ).json()
        cycle = await client.patch(
            f"/api/storage/entries/{parent['id']}", json={"parent_id": child["id"]}
        )
        assert cycle.status_code == 409

        database = Database(migrated_db_url)
        try:
            async with database.sessionmaker() as session:
                workspace = await session.get(StorageWorkspace, "ws_department:engineering")
                assert workspace is not None
                workspace.state = "read_only"
                await session.commit()
        finally:
            await database.dispose()
        denied = await client.post(
            "/api/storage/workspaces/ws_department:engineering/folders",
            json={"name": "Denied"},
        )
        assert denied.status_code == 409


async def test_reconciliation_marks_corrupt_missing_and_recovered_blobs(
    tmp_path: Path, migrated_db_url: str, make_settings: Any, make_client: Any
) -> None:
    root = tmp_path / "storage"
    original = b"verified contents"
    async with storage_client(make_settings, make_client, migrated_db_url, root) as client:
        uploaded = (
            await client.post(
                "/api/storage/workspaces/ws_company/files",
                files={"file": ("verified.txt", original, "text/plain")},
            )
        ).json()
        database = Database(migrated_db_url)
        try:
            async with database.sessionmaker() as session:
                version = await session.scalar(
                    select(StorageVersion).where(StorageVersion.entry_id == uploaded["id"])
                )
                assert version is not None
                blob_path = root.joinpath(*version.storage_key.split("/"))
        finally:
            await database.dispose()

        blob_path.write_bytes(b"tampered")
        orphan = root / "objects" / "aa" / ("a" * 32)
        orphan.parent.mkdir(parents=True, exist_ok=True)
        orphan.write_bytes(b"orphan")
        failed_download = await client.get(f"/api/storage/entries/{uploaded['id']}/download")
        assert failed_download.status_code == 409
        corrupt = (await client.post("/api/storage/maintenance/reconcile")).json()
        assert corrupt["checked"] == 1
        assert corrupt["corrupt"] == 1
        assert corrupt["orphaned"] == 1

        blob_path.write_bytes(original)
        recovered = (await client.post("/api/storage/maintenance/reconcile")).json()
        assert recovered["recovered"] == 1
        assert (
            await client.get(f"/api/storage/entries/{uploaded['id']}/download")
        ).content == original

        blob_path.unlink()
        missing = (await client.post("/api/storage/maintenance/reconcile")).json()
        assert missing["missing"] == 1


async def test_symbolic_link_blob_is_never_followed(
    tmp_path: Path, migrated_db_url: str, make_settings: Any, make_client: Any
) -> None:
    root = tmp_path / "storage"
    outside = tmp_path / "outside.txt"
    outside.write_bytes(b"outside")
    async with storage_client(make_settings, make_client, migrated_db_url, root) as client:
        uploaded = (
            await client.post(
                "/api/storage/workspaces/ws_company/files",
                files={"file": ("linked.txt", b"inside", "text/plain")},
            )
        ).json()
        database = Database(migrated_db_url)
        try:
            async with database.sessionmaker() as session:
                version = await session.scalar(
                    select(StorageVersion).where(StorageVersion.entry_id == uploaded["id"])
                )
                assert version is not None
                blob_path = root.joinpath(*version.storage_key.split("/"))
        finally:
            await database.dispose()
        blob_path.unlink()
        try:
            os.symlink(outside, blob_path)
        except OSError:
            pytest.skip("Symbolic links are unavailable on this host")

        result = (await client.post("/api/storage/maintenance/reconcile")).json()
        assert result["corrupt"] == 1
        assert result["unsafe"] >= 1
        assert (
            await client.get(f"/api/storage/entries/{uploaded['id']}/download")
        ).status_code == 409
        assert outside.read_bytes() == b"outside"


async def test_interrupted_blob_write_leaves_no_partial_file(tmp_path: Path) -> None:
    store = LocalBlobStore(tmp_path / "storage")
    calls = 0

    async def interrupted(_size: int) -> bytes:
        nonlocal calls
        calls += 1
        if calls == 1:
            return b"partial"
        raise RuntimeError("upload interrupted")

    with pytest.raises(RuntimeError, match="upload interrupted"):
        await store.put(interrupted, 100)
    assert list((store.temporary).iterdir()) == []
    assert [path for path in store.objects.rglob("*") if path.is_file()] == []


async def test_stream_limit_removes_partial_file(tmp_path: Path) -> None:
    store = LocalBlobStore(tmp_path / "storage")
    sent = False

    async def oversized(_size: int) -> bytes:
        nonlocal sent
        if sent:
            return b""
        sent = True
        return b"too large"

    with pytest.raises(BlobLimitError):
        await store.put(oversized, 3)
    assert list(store.temporary.iterdir()) == []
    assert [path for path in store.objects.rglob("*") if path.is_file()] == []
