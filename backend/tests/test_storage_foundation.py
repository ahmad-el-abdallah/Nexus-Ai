"""Digital Vault metadata, logical names and migration seeding."""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.exc import IntegrityError

from app.db.session import Database
from app.models import (
    Department,
    Employee,
    StorageEntry,
    StorageEntryKind,
    StorageEntryStatus,
    StorageEvent,
    StorageGrant,
    StorageLink,
    StorageLinkTarget,
    StorageTag,
    StorageVersion,
    StorageWorkspace,
    StorageWorkspaceScope,
)
from app.storage.names import (
    MAX_LOGICAL_PATH_CHARS,
    MAX_LOGICAL_SEGMENT_CHARS,
    StorageNameError,
    logical_path,
    logical_path_key,
)
from tests.conftest import run_migrations


@pytest.fixture
async def storage_db(migrated_db_url: str) -> AsyncIterator[Database]:
    database = Database(migrated_db_url)
    try:
        yield database
    finally:
        await database.dispose()


def entry(
    entry_id: str,
    path: str,
    *,
    kind: StorageEntryKind = StorageEntryKind.FOLDER,
    employee_id: str | None = None,
) -> StorageEntry:
    canonical = logical_path(path)
    is_file = kind == StorageEntryKind.FILE
    return StorageEntry(
        id=entry_id,
        workspace_id="ws_department:engineering",
        kind=kind.value,
        path=canonical,
        path_key=logical_path_key(canonical),
        name=canonical.rsplit("/", 1)[-1],
        original_name=canonical.rsplit("/", 1)[-1] if is_file else None,
        visibility="department",
        status=StorageEntryStatus.AVAILABLE.value,
        current_version_number=1 if is_file else 0,
        created_by_kind="employee" if employee_id else "owner",
        created_by_employee_id=employee_id,
        created_by_name="Storage Tester" if employee_id else "Owner",
        owner_kind="department",
        owner_id="engineering",
        owner_name="Software Engineering",
    )


def version(version_id: str, entry_id: str, *, employee_id: str | None = None) -> StorageVersion:
    return StorageVersion(
        id=version_id,
        entry_id=entry_id,
        number=1,
        backend="local",
        storage_key=f"objects/{version_id}",
        original_name="report.txt",
        mime_type="text/plain",
        size_bytes=12,
        sha256="a" * 64,
        status="available",
        created_by_kind="employee" if employee_id else "owner",
        created_by_employee_id=employee_id,
        created_by_name="Storage Tester" if employee_id else "Owner",
    )


def test_migration_seeds_company_and_every_registered_department_dynamically(db_url: str) -> None:
    run_migrations(db_url, "0012_apps")
    sync_url = db_url.replace("sqlite+aiosqlite", "sqlite", 1)
    engine = create_engine(sync_url)
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                INSERT INTO departments (
                    key, position, name, description, responsibilities, roles, color,
                    room_id, director_id, model_id, max_concurrent_tasks,
                    daily_request_budget
                ) VALUES (
                    'field-lab', 999, 'Field Lab', 'A migration-seed test department.',
                    '[]', '["Field Director"]', '#123456', NULL, NULL, NULL, 2, 200
                )
                """
            )
        )
    engine.dispose()

    run_migrations(db_url)
    engine = create_engine(sync_url)
    with engine.connect() as connection:
        department_count = connection.scalar(text("SELECT count(*) FROM departments"))
        workspace_count = connection.scalar(text("SELECT count(*) FROM storage_workspaces"))
        company = connection.execute(
            text("SELECT id, scope, department_key FROM storage_workspaces WHERE id = 'ws_company'")
        ).one()
        field_lab = connection.execute(
            text("SELECT id, scope FROM storage_workspaces WHERE department_key = 'field-lab'")
        ).one()
    engine.dispose()

    assert workspace_count == department_count + 1
    assert company == ("ws_company", "company", None)
    assert field_lab == ("ws_department:field-lab", "department")


def test_logical_paths_are_nfkc_normalised_and_unsafe_forms_are_rejected() -> None:
    assert logical_path("Projects/\uff26oo/Report.TXT") == "Projects/Foo/Report.TXT"
    assert logical_path_key("Projects/\uff23afé/Report.TXT") == "projects/café/report.txt"

    invalid = (
        "",
        "/absolute/file.txt",
        "//server/share/file.txt",
        "C:/drive/file.txt",
        "folder\\file.txt",
        "folder/\x00file.txt",
        "folder/../file.txt",
        "folder/./file.txt",
        "folder//file.txt",
        "folder/",
        "x" * (MAX_LOGICAL_SEGMENT_CHARS + 1),
        "/".join(["segment"] * (MAX_LOGICAL_PATH_CHARS // 4)),
    )
    for path in invalid:
        with pytest.raises(StorageNameError):
            logical_path(path)


async def test_path_key_is_unique_per_workspace_after_nfkc_and_casefold(
    storage_db: Database,
) -> None:
    async with storage_db.sessionmaker() as session:
        session.add(entry("ste_path_one", "Reports/\uff23afé.TXT"))
        await session.commit()

    async with storage_db.sessionmaker() as session:
        # Combining acute + different case normalise to the first entry's key.
        session.add(entry("ste_path_two", "reports/cafe\u0301.txt"))
        with pytest.raises(IntegrityError):
            await session.commit()


async def test_versions_links_and_tags_enforce_idempotent_uniqueness(
    storage_db: Database,
) -> None:
    file = entry("ste_constraints", "Projects/Report.txt", kind=StorageEntryKind.FILE)
    stored = version("stv_constraints", file.id)
    link = StorageLink(
        id="stl_constraints",
        entry_id=file.id,
        version_id=stored.id,
        target_type=StorageLinkTarget.PROJECT.value,
        target_id="future_project_1",
        relation="artifact",
        idempotency_key="project:future_project_1:Projects/Report.txt:v1",
    )
    tag = StorageTag(entry_id=file.id, tag="Important", tag_key="important")
    async with storage_db.sessionmaker() as session:
        session.add_all([file, stored])
        await session.flush()
        session.add_all([link, tag])
        await session.commit()

    duplicate_version = StorageVersion(
        **{
            key: value
            for key, value in version("stv_duplicate", file.id).__dict__.items()
            if not key.startswith("_sa_")
        }
    )
    duplicate_version.storage_key = "objects/stv_duplicate"
    async with storage_db.sessionmaker() as session:
        session.add(duplicate_version)
        with pytest.raises(IntegrityError):
            await session.commit()

    async with storage_db.sessionmaker() as session:
        session.add(
            StorageLink(
                id="stl_duplicate",
                entry_id=file.id,
                target_type="task",
                target_id="tsk_other",
                idempotency_key=link.idempotency_key,
            )
        )
        with pytest.raises(IntegrityError):
            await session.commit()

    async with storage_db.sessionmaker() as session:
        session.add(StorageTag(entry_id=file.id, tag="IMPORTANT", tag_key="important"))
        with pytest.raises(IntegrityError):
            await session.commit()


async def test_employee_attribution_is_set_null_but_snapshots_survive(
    storage_db: Database,
) -> None:
    employee = Employee(
        id="emp_storage_test",
        name="Storage Tester",
        role="Backend Developer",
        department="engineering",
        seniority="mid",
        supervisor_id=None,
        avatar_seed=999001,
        status="idle",
    )
    file = entry(
        "ste_employee_history",
        "Projects/Employee.txt",
        kind=StorageEntryKind.FILE,
        employee_id=employee.id,
    )
    stored = version("stv_employee_history", file.id, employee_id=employee.id)
    grant = StorageGrant(
        id="stg_employee_history",
        workspace_id=file.workspace_id,
        entry_id=file.id,
        grantee_kind="department",
        grantee_id="quality-assurance",
        permission="read",
        granted_by_kind="employee",
        granted_by_employee_id=employee.id,
        granted_by_name=employee.name,
    )
    event = StorageEvent(
        workspace_id=file.workspace_id,
        entry_id=file.id,
        version_id=stored.id,
        level="info",
        kind="created",
        actor_kind="employee",
        actor_employee_id=employee.id,
        actor_name=employee.name,
        text="Stored a test artifact.",
        details={},
    )
    async with storage_db.sessionmaker() as session:
        session.add(employee)
        await session.flush()
        session.add_all([file, stored])
        await session.flush()
        session.add_all([grant, event])
        await session.commit()

    async with storage_db.sessionmaker() as session:
        person = await session.get(Employee, employee.id)
        assert person is not None
        await session.delete(person)
        await session.commit()

    async with storage_db.sessionmaker() as session:
        saved_entry = await session.get(StorageEntry, file.id)
        saved_version = await session.get(StorageVersion, stored.id)
        saved_grant = await session.get(StorageGrant, grant.id)
        saved_event = await session.scalar(
            select(StorageEvent).where(StorageEvent.kind == "created")
        )
        assert saved_entry is not None and saved_entry.created_by_employee_id is None
        assert saved_entry.created_by_name == "Storage Tester"
        assert saved_version is not None and saved_version.created_by_employee_id is None
        assert saved_version.created_by_name == "Storage Tester"
        assert saved_grant is not None and saved_grant.granted_by_employee_id is None
        assert saved_grant.granted_by_name == "Storage Tester"
        assert saved_event is not None and saved_event.actor_employee_id is None
        assert saved_event.actor_name == "Storage Tester"


async def test_department_deletion_is_restricted_and_entry_purge_keeps_audit(
    storage_db: Database,
) -> None:
    department = Department(
        key="storage-lab",
        position=999,
        name="Storage Lab",
        description="Tests workspace ownership.",
        responsibilities=[],
        roles=["Storage Director"],
        color="#123456",
        room_id=None,
        director_id=None,
        max_concurrent_tasks=2,
        daily_request_budget=200,
    )
    workspace = StorageWorkspace(
        id="ws_department:storage-lab",
        scope=StorageWorkspaceScope.DEPARTMENT.value,
        department_key=department.key,
        state="active",
    )
    async with storage_db.sessionmaker() as session:
        session.add_all([department, workspace])
        await session.commit()

    async with storage_db.sessionmaker() as session:
        stored_department = await session.get(Department, department.key)
        assert stored_department is not None
        await session.delete(stored_department)
        with pytest.raises(IntegrityError):
            await session.commit()

    file = entry("ste_purge", "Projects/Purge.txt", kind=StorageEntryKind.FILE)
    stored = version("stv_purge", file.id)
    async with storage_db.sessionmaker() as session:
        session.add_all([file, stored])
        await session.flush()
        session.add_all(
            [
                StorageTag(entry_id=file.id, tag="Temporary", tag_key="temporary"),
                StorageLink(
                    id="stl_purge",
                    entry_id=file.id,
                    version_id=stored.id,
                    target_type="task",
                    target_id="tsk_purge",
                    idempotency_key="task:tsk_purge:artifact",
                ),
                StorageGrant(
                    id="stg_purge",
                    workspace_id=file.workspace_id,
                    entry_id=file.id,
                    grantee_kind="department",
                    grantee_id="quality-assurance",
                    permission="read",
                    granted_by_kind="owner",
                    granted_by_name="Owner",
                ),
                StorageEvent(
                    workspace_id=file.workspace_id,
                    entry_id=file.id,
                    version_id=stored.id,
                    level="info",
                    kind="purge_test",
                    actor_kind="owner",
                    actor_name="Owner",
                    text="Audit survives metadata purge.",
                    details={},
                ),
            ]
        )
        await session.commit()

    async with storage_db.sessionmaker() as session:
        saved = await session.get(StorageEntry, file.id)
        assert saved is not None
        await session.delete(saved)
        await session.commit()

    async with storage_db.sessionmaker() as session:
        assert (
            await session.scalar(
                select(func.count())
                .select_from(StorageVersion)
                .where(StorageVersion.entry_id == file.id)
            )
            == 0
        )
        assert (
            await session.scalar(
                select(func.count()).select_from(StorageLink).where(StorageLink.entry_id == file.id)
            )
            == 0
        )
        assert (
            await session.scalar(
                select(func.count()).select_from(StorageTag).where(StorageTag.entry_id == file.id)
            )
            == 0
        )
        assert (
            await session.scalar(
                select(func.count())
                .select_from(StorageGrant)
                .where(StorageGrant.entry_id == file.id)
            )
            == 0
        )
        audit = await session.scalar(select(StorageEvent).where(StorageEvent.kind == "purge_test"))
        assert audit is not None
        assert audit.entry_id is None and audit.version_id is None
