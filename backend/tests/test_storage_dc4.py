from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import select

from app.core.config import Settings
from app.db.session import Database
from app.models import App, Department, Employee, Task
from app.storage.errors import VaultError
from app.storage.service import VaultService


async def test_new_department_gets_a_workspace_while_the_app_is_running(
    client: httpx.AsyncClient, migrated_db_url: str
) -> None:
    database = Database(migrated_db_url)
    try:
        async with database.sessionmaker() as session:
            session.add(
                Department(
                    key="quality",
                    position=99,
                    name="Quality Assurance",
                    description="Validates product quality.",
                    responsibilities=["Test releases"],
                    roles=["QA Director"],
                    color="#10b981",
                    max_concurrent_tasks=2,
                    daily_request_budget=100,
                )
            )
            await session.commit()
    finally:
        await database.dispose()

    workspaces = (await client.get("/api/storage/workspaces")).json()
    created = next(item for item in workspaces if item["id"] == "ws_department:quality")
    assert created["department_key"] == "quality"
    assert created["state"] == "active"


async def test_workspace_quota_override_and_read_only_state_are_enforced(
    client: httpx.AsyncClient,
) -> None:
    upload = await client.post(
        "/api/storage/workspaces/ws_department:engineering/files",
        files={"file": ("quota.txt", b"12345", "text/plain")},
    )
    assert upload.status_code == 201

    too_small = await client.patch(
        "/api/storage/workspaces/ws_department:engineering", json={"quota_bytes": 4}
    )
    assert too_small.status_code == 409
    updated = await client.patch(
        "/api/storage/workspaces/ws_department:engineering",
        json={"quota_bytes": 5, "state": "read_only"},
    )
    assert updated.status_code == 200
    assert updated.json()["quota_bytes"] == 5
    assert updated.json()["quota_override_bytes"] == 5
    assert updated.json()["state"] == "read_only"
    denied = await client.post(
        "/api/storage/workspaces/ws_department:engineering/folders",
        json={"name": "Denied"},
    )
    assert denied.status_code == 409


async def test_employee_policy_and_entry_grants_are_enforced_and_revocable(
    tmp_path: Path, migrated_db_url: str, make_settings: Any
) -> None:
    settings: Settings = make_settings(
        NEXUS_DATABASE_URL=migrated_db_url, NEXUS_STORAGE_ROOT=tmp_path / "storage"
    )
    vault = VaultService(settings)
    await vault.initialize()
    database = Database(migrated_db_url)
    try:
        async with database.sessionmaker() as session:
            engineer = await session.scalar(
                select(Employee).where(Employee.department == "engineering")
            )
            marketer = await session.scalar(
                select(Employee).where(Employee.department == "marketing")
            )
            assert engineer is not None and marketer is not None
            engineering_actor = await vault.actor_for_employee(session, engineer.id)
            marketing_actor = await vault.actor_for_employee(session, marketer.id)
            folder = await vault.create_folder(
                session,
                "ws_department:engineering",
                "Shared",
                None,
                actor=engineering_actor,
            )
            with pytest.raises(VaultError, match="required access"):
                await vault.entries(
                    session,
                    "ws_department:engineering",
                    folder["id"],
                    trashed=False,
                    actor=marketing_actor,
                )
            grant = await vault.grant_access(
                session,
                "ws_department:engineering",
                grantee_kind="employee",
                grantee_id=marketer.id,
                permission="read",
                entry_id=folder["id"],
            )
            assert (
                await vault.entries(
                    session,
                    "ws_department:engineering",
                    folder["id"],
                    trashed=False,
                    actor=marketing_actor,
                )
                == []
            )
            with pytest.raises(VaultError, match="required access"):
                await vault.create_folder(
                    session,
                    "ws_department:engineering",
                    "No write",
                    folder["id"],
                    actor=marketing_actor,
                )
            await vault.revoke_grant(session, grant["id"])
            with pytest.raises(VaultError, match="required access"):
                await vault.entries(
                    session,
                    "ws_department:engineering",
                    folder["id"],
                    trashed=False,
                    actor=marketing_actor,
                )
    finally:
        await database.dispose()


async def test_grants_and_real_task_app_links_are_owner_managed(
    client: httpx.AsyncClient, migrated_db_url: str
) -> None:
    database = Database(migrated_db_url)
    try:
        async with database.sessionmaker() as session:
            employee = await session.scalar(select(Employee).where(Employee.department == "sales"))
            assert employee is not None
            session.add_all(
                [
                    Task(
                        id="task_storage_link",
                        title="Engineering delivery",
                        description="Produce the linked artifact.",
                        department="engineering",
                        status="open",
                        kind="manual",
                    ),
                    Task(
                        id="task_wrong_department",
                        title="Marketing delivery",
                        description="Wrong workspace.",
                        department="marketing",
                        status="open",
                        kind="manual",
                    ),
                    App(
                        id="app_storage_link",
                        name="Artifact Viewer",
                        description="Displays stored artifacts.",
                        current_version=1,
                    ),
                ]
            )
            await session.commit()
            employee_id = employee.id
    finally:
        await database.dispose()

    folder = (
        await client.post(
            "/api/storage/workspaces/ws_department:engineering/folders",
            json={"name": "Deliverables"},
        )
    ).json()
    grant = await client.post(
        "/api/storage/workspaces/ws_department:engineering/grants",
        json={
            "grantee_kind": "employee",
            "grantee_id": employee_id,
            "permission": "read",
            "entry_id": folder["id"],
        },
    )
    assert grant.status_code == 201, grant.text
    listed = await client.get("/api/storage/workspaces/ws_department:engineering/grants")
    assert [item["id"] for item in listed.json()] == [grant.json()["id"]]

    task_link = await client.post(
        f"/api/storage/entries/{folder['id']}/links",
        json={"target_type": "task", "target_id": "task_storage_link"},
    )
    assert task_link.status_code == 201, task_link.text
    duplicate = await client.post(
        f"/api/storage/entries/{folder['id']}/links",
        json={"target_type": "task", "target_id": "task_storage_link"},
    )
    assert duplicate.json()["id"] == task_link.json()["id"]
    app_link = await client.post(
        f"/api/storage/entries/{folder['id']}/links",
        json={"target_type": "app", "target_id": "app_storage_link", "relation": "output"},
    )
    assert app_link.status_code == 201, app_link.text
    wrong_department = await client.post(
        f"/api/storage/entries/{folder['id']}/links",
        json={"target_type": "task", "target_id": "task_wrong_department"},
    )
    assert wrong_department.status_code == 409
    links = (await client.get(f"/api/storage/entries/{folder['id']}/links")).json()
    assert {(link["target_type"], link["target_id"]) for link in links} == {
        ("task", "task_storage_link"),
        ("app", "app_storage_link"),
    }
    revoked = await client.delete(f"/api/storage/grants/{grant.json()['id']}")
    assert revoked.status_code == 200
    assert revoked.json()["revoked_at"] is not None

    overview = (await client.get("/api/storage/overview")).json()
    assert overview["active_grant_count"] == 0
    assert overview["linked_entry_count"] == 1
