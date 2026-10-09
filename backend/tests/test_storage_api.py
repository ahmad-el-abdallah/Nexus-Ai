from __future__ import annotations

import httpx

from app.models import StorageEntry, StorageEvent, StorageVersion


async def test_storage_overview_reports_real_aggregate_metadata(
    client: httpx.AsyncClient, migrated_db_url: str
) -> None:
    from app.db.session import Database

    database = Database(migrated_db_url)
    try:
        async with database.sessionmaker() as session:
            entry = StorageEntry(
                id="ste_overview",
                workspace_id="ws_department:engineering",
                kind="file",
                path="Projects/report.txt",
                path_key="projects/report.txt",
                name="report.txt",
                original_name="report.txt",
                visibility="department",
                status="available",
                current_version_number=1,
                created_by_kind="owner",
                created_by_name="Owner",
                owner_kind="department",
                owner_id="engineering",
                owner_name="Software Engineering",
            )
            version = StorageVersion(
                id="stv_overview",
                entry_id=entry.id,
                number=1,
                backend="local",
                storage_key="objects/private-overview-key",
                original_name="report.txt",
                mime_type="text/plain",
                size_bytes=37,
                sha256="a" * 64,
                status="available",
                created_by_kind="owner",
                created_by_name="Owner",
            )
            session.add_all([entry, version])
            await session.flush()
            session.add(
                StorageEvent(
                    workspace_id=entry.workspace_id,
                    entry_id=entry.id,
                    version_id=version.id,
                    level="info",
                    kind="overview_test",
                    actor_kind="owner",
                    actor_name="Owner",
                    text="Test event",
                    details={},
                )
            )
            await session.commit()
    finally:
        await database.dispose()

    response = await client.get("/api/storage/overview")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "metadata_ready"
    assert body["backend"] == "local"
    assert body["writes_enabled"] is False
    assert body["workspace_count"] == body["department_workspace_count"] + 1
    assert body["entry_count"] == body["file_count"] == body["version_count"] == 1
    assert body["folder_count"] == 0
    assert body["stored_bytes"] == 37
    assert body["quota_bytes_per_department"] == 10 * 1024 * 1024 * 1024
    assert body["backup_configured"] is False
    assert body["last_event_at"] is not None
    assert "private-overview-key" not in response.text
    assert "storage_root" not in response.text


async def test_empty_storage_overview_is_honest(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/storage/overview")
    assert response.status_code == 200
    body = response.json()
    assert body["workspace_count"] > 1
    assert body["entry_count"] == 0
    assert body["stored_bytes"] == 0
    assert body["last_event_at"] is None
