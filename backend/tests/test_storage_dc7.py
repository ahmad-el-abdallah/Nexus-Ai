from __future__ import annotations

import io
import zipfile
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import select

from app.models import (
    App,
    AppFile,
    AppVersion,
    CodeRun,
    Employee,
    StorageEntry,
    StorageEvent,
    StorageLink,
    StorageVersion,
    Task,
)
from app.storage.insights import VaultInsights

ENGINEERING = "/api/storage/workspaces/ws_department:engineering"


async def upload(
    client: httpx.AsyncClient,
    name: str,
    content: bytes,
    *,
    workspace: str = ENGINEERING,
    mime: str = "text/plain",
) -> dict[str, Any]:
    response = await client.post(f"{workspace}/files", files={"file": (name, content, mime)})
    assert response.status_code == 201, response.text
    return response.json()


async def add_version(
    client: httpx.AsyncClient, entry_id: str, name: str, content: bytes, note: str | None = None
) -> httpx.Response:
    return await client.post(
        f"/api/storage/entries/{entry_id}/versions",
        data={"change_description": note} if note else None,
        files={"file": (name, content, "text/plain")},
    )


async def diff(client: httpx.AsyncClient, **params: Any) -> dict[str, Any]:
    response = await client.get("/api/storage/diff", params=params)
    assert response.status_code == 200, response.text
    return response.json()


async def test_versions_are_immutable_comparable_and_restorable(client: httpx.AsyncClient) -> None:
    first = b"line one\nline two\n"
    second = b"line one\nline 2\nline three\n"
    entry = await upload(client, "notes.txt", first)
    entry_id = entry["id"]

    added = await add_version(client, entry_id, "notes.txt", second, "Second draft")
    assert added.status_code == 201, added.text
    assert added.json()["current_version_number"] == 2
    assert (await add_version(client, entry_id, "notes.txt", second)).status_code == 409
    assert (await add_version(client, entry_id, "notes.md", b"other type")).status_code == 422

    detail = (await client.get(f"/api/storage/entries/{entry_id}")).json()
    assert detail["source_managed"] is False
    assert [(v["number"], v["is_current"]) for v in detail["versions"]] == [(2, True), (1, False)]
    assert detail["versions"][0]["change_description"] == "Second draft"
    assert detail["versions"][0]["created_by_kind"] == "owner"

    download = f"/api/storage/entries/{entry_id}/download"
    assert (await client.get(download)).content == second
    assert (await client.get(download, params={"version": 1})).content == first
    assert (await client.get(download, params={"version": 9})).status_code == 404
    old_preview = await client.get(
        f"/api/storage/entries/{entry_id}/preview", params={"version": 1}
    )
    assert old_preview.text == first.decode()

    compared = await diff(
        client, before_entry=entry_id, before_version=1, after_entry=entry_id, after_version=2
    )
    assert compared["comparable"] is True and compared["identical"] is False
    assert (compared["added"], compared["removed"]) == (2, 1)
    assert compared["before"]["version"] == 1 and compared["after"]["version"] == 2
    shown = [(line["kind"], line["old"], line["new"], line["text"]) for line in compared["lines"]]
    assert shown == [
        ("hunk", None, None, "@@ -1,2 +1,3 @@"),
        ("context", 1, 1, "line one"),
        ("remove", 2, None, "line two"),
        ("add", None, 2, "line 2"),
        ("add", None, 3, "line three"),
    ]

    restored = await client.post(f"/api/storage/entries/{entry_id}/versions/1/restore")
    assert restored.status_code == 201, restored.text
    assert restored.json()["current_version_number"] == 3
    assert restored.json()["sha256"] == sha256(first).hexdigest()
    # History is extended, never rewritten: every earlier version keeps its bytes.
    assert (await client.get(download)).content == first
    assert (await client.get(download, params={"version": 1})).content == first
    assert (await client.get(download, params={"version": 2})).content == second
    detail = (await client.get(f"/api/storage/entries/{entry_id}")).json()
    assert [v["number"] for v in detail["versions"]] == [3, 2, 1]
    assert detail["versions"][0]["change_description"] == "Restored from version 1."
    assert len({v["id"] for v in detail["versions"]}) == 3
    assert any(event["kind"] == "version_restored" for event in detail["events"])

    restore = f"/api/storage/entries/{entry_id}/versions"
    assert (await client.post(f"{restore}/3/restore")).status_code == 409  # already current
    assert (await client.post(f"{restore}/1/restore")).status_code == 409  # same content
    assert (await client.post(f"{restore}/9/restore")).status_code == 404
    assert (await client.delete(f"/api/storage/entries/{entry_id}")).status_code == 200
    assert (await client.post(f"{restore}/2/restore")).status_code == 409  # in Trash

    folder = await client.post(f"{ENGINEERING}/folders", json={"name": "Docs"})
    assert (await add_version(client, folder.json()["id"], "x.txt", b"x")).status_code == 409


async def test_comparison_is_bounded_and_honest_about_what_it_cannot_show(
    client: httpx.AsyncClient,
) -> None:
    image = await upload(client, "diagram.png", b"\x89PNG one", mime="image/png")
    assert (
        await add_version(client, image["id"], "diagram.png", b"\x89PNG two")
    ).status_code == 201
    binary = await diff(client, before_entry=image["id"], before_version=1, after_entry=image["id"])
    assert binary["comparable"] is False and binary["lines"] == []
    assert binary["reason"] == "Only text files can be compared line by line."
    assert binary["before"]["sha256"] != binary["after"]["sha256"]

    large = await upload(client, "large.txt", b"a\n" * (300 * 1024))
    assert (await add_version(client, large["id"], "large.txt", b"b\n" * (300 * 1024))).is_success
    too_large = await diff(
        client, before_entry=large["id"], before_version=1, after_entry=large["id"]
    )
    assert too_large["comparable"] is False
    assert "512 KiB" in too_large["reason"]

    endings = await upload(client, "endings.txt", b"a\nb\n")
    assert (await add_version(client, endings["id"], "endings.txt", b"a\r\nb\r\n")).is_success
    only_endings = await diff(
        client, before_entry=endings["id"], before_version=1, after_entry=endings["id"]
    )
    assert only_endings["comparable"] is True and only_endings["identical"] is False
    assert only_endings["line_endings_only"] is True and only_endings["lines"] == []

    same = await diff(
        client, before_entry=endings["id"], before_version=2, after_entry=endings["id"]
    )
    assert same["identical"] is True and same["line_endings_only"] is False

    long = await upload(client, "long.txt", b"".join(b"old %d\n" % n for n in range(3000)))
    changed = b"".join(b"new %d\n" % n for n in range(3000))
    assert (await add_version(client, long["id"], "long.txt", changed)).is_success
    capped = await diff(client, before_entry=long["id"], before_version=1, after_entry=long["id"])
    assert capped["truncated"] is True and len(capped["lines"]) == 2000
    assert (capped["added"], capped["removed"]) == (3000, 3000)  # totals stay complete

    missing = await client.get(
        "/api/storage/diff", params={"before_entry": "ste_none", "after_entry": long["id"]}
    )
    assert missing.status_code == 404


async def test_mirrored_artifacts_cannot_be_replaced_or_forged(
    tmp_path: Path, migrated_db_url: str, make_settings: Any, make_client: Any
) -> None:
    wrapper = make_client(
        make_settings(NEXUS_DATABASE_URL=migrated_db_url, NEXUS_STORAGE_ROOT=tmp_path / "storage")
    )
    async with wrapper as client:
        database = wrapper.app.state.db
        registrar = wrapper.app.state.artifacts
        async with database.sessionmaker() as session:
            engineer = await session.scalar(
                select(Employee).where(Employee.department == "engineering")
            )
            assert engineer is not None
            session.add(
                Task(
                    id="tsk_dc7",
                    title="Mirrored result",
                    description="Write it",
                    department="engineering",
                    assignee_id=engineer.id,
                    status="done",
                    kind="manual",
                    result="First result\n",
                    finished_at=datetime.now(UTC),
                )
            )
            await session.commit()
        assert (await registrar.register_task("tsk_dc7")).registered == 1
        async with database.sessionmaker() as session:
            task = await session.get(Task, "tsk_dc7")
            assert task is not None
            task.result = "Second result\n"
            await session.commit()
        assert (await registrar.register_task("tsk_dc7")).registered == 1
        async with database.sessionmaker() as session:
            entry_id = await session.scalar(
                select(StorageLink.entry_id).where(
                    StorageLink.target_type == "task", StorageLink.relation == "result"
                )
            )
        assert entry_id is not None

        detail = (await client.get(f"/api/storage/entries/{entry_id}")).json()
        assert detail["source_managed"] is True
        assert [v["number"] for v in detail["versions"]] == [2, 1]
        assert detail["versions"][0]["created_by_kind"] == "employee"

        # The task stays authoritative: its mirror can be read and compared, not replaced.
        replaced = await add_version(client, entry_id, detail["name"], b"Owner text\n")
        assert replaced.status_code == 409 and "mirrors a task" in replaced.json()["detail"]
        restored = await client.post(f"/api/storage/entries/{entry_id}/versions/1/restore")
        assert restored.status_code == 409 and "mirrors a task" in restored.json()["detail"]
        old = await client.get(f"/api/storage/entries/{entry_id}/download", params={"version": 1})
        assert old.content == b"First result\n"
        compared = await diff(client, before_entry=entry_id, before_version=1, after_entry=entry_id)
        assert (compared["added"], compared["removed"]) == (1, 1)
        still = (await client.get(f"/api/storage/entries/{entry_id}")).json()
        assert still["current_version_number"] == 2

        # Nobody but the registrar may claim that a file is a task's result.
        own = await upload(client, "mine.md", b"my own text")
        forged = await client.post(
            f"/api/storage/entries/{own['id']}/links",
            json={"target_type": "task", "target_id": "tsk_dc7", "relation": "result"},
        )
        assert forged.status_code == 422, forged.text
        assert "reserved" in forged.json()["detail"]
        by_employee = None
        try:
            await registrar.link(
                engineer.id, own["id"], target_type="task", target_id="tsk_dc7", relation="result"
            )
        except Exception as error:
            by_employee = error
        assert by_employee is not None and getattr(by_employee, "status", None) == 422
        honest = await client.post(
            f"/api/storage/entries/{own['id']}/links",
            json={"target_type": "task", "target_id": "tsk_dc7", "relation": "reference"},
        )
        assert honest.status_code == 201, honest.text
        own_detail = (await client.get(f"/api/storage/entries/{own['id']}")).json()
        assert own_detail["source_managed"] is False


async def test_engineering_projects_show_stored_versions_and_real_changes(
    tmp_path: Path, migrated_db_url: str, make_settings: Any, make_client: Any
) -> None:
    wrapper = make_client(
        make_settings(NEXUS_DATABASE_URL=migrated_db_url, NEXUS_STORAGE_ROOT=tmp_path / "storage")
    )
    trees = {
        1: {"server.py": "print('one')\n", "README.md": "# Notes\n", "static/old.js": "old();\n"},
        2: {"server.py": "print('two')\n", "README.md": "# Notes\n", "static/app.js": "app();\n"},
    }
    async with wrapper as client:
        database = wrapper.app.state.db
        registrar = wrapper.app.state.artifacts
        assert (await client.get("/api/storage/projects")).json() == []
        async with database.sessionmaker() as session:
            engineer = await session.scalar(
                select(Employee).where(Employee.department == "engineering")
            )
            assert engineer is not None
            session.add(
                App(id="app_dc7", name="Notes", description="A notes app", current_version=3)
            )
            await session.flush()
            for number, status in ((1, "ready"), (2, "ready"), (3, "failed")):
                session.add(
                    AppVersion(
                        id=f"av_dc7_{number}",
                        app_id="app_dc7",
                        number=number,
                        base_version=number - 1 or None,
                        request=f"Request {number}",
                        status=status,
                        stack="python",
                        max_calls=20,
                        finished_at=datetime.now(UTC),
                    )
                )
            await session.flush()
            for number, tree in trees.items():
                for position, (path, content) in enumerate(tree.items()):
                    session.add(
                        AppFile(
                            version_id=f"av_dc7_{number}",
                            path=path,
                            position=position,
                            area="frontend" if path.startswith("static/") else "backend",
                            purpose=f"Purpose of {path}",
                            action="new",
                            employee_id=engineer.id,
                            author_name=engineer.name,
                            author_role=engineer.role,
                            status="written",
                            content=content,
                        )
                    )
            await session.commit()

        listed = (await client.get("/api/storage/projects")).json()
        assert [(p["id"], p["version_count"], p["ready_version_count"]) for p in listed] == [
            ("app_dc7", 3, 2)
        ]
        # Nothing has been stored yet, and the viewer says so instead of inventing files.
        assert listed[0]["stored_file_count"] == 0 and listed[0]["latest_status"] == "failed"
        before = (await client.get("/api/storage/projects/app_dc7")).json()
        assert {f["state"] for f in before["versions"][0]["files"]} == {"not_stored"}
        assert before["versions"][0]["folder_id"] is None

        for number in (1, 2):
            assert (await registrar.register_app_version(f"av_dc7_{number}")).registered == 3

        listed = (await client.get("/api/storage/projects")).json()
        assert listed[0]["stored_file_count"] == 6
        assert listed[0]["stored_bytes"] == sum(
            len(c) for tree in trees.values() for c in tree.values()
        )

        project = (await client.get("/api/storage/projects/app_dc7")).json()
        one, two, three = project["versions"]
        assert [f["change"] for f in one["files"]] == [None, None, None]
        assert one["base_version"] is None and one["removed"] == []
        assert {f["path"]: f["change"] for f in two["files"]} == {
            "server.py": "modified",
            "README.md": "unchanged",
            "static/app.js": "added",
        }
        assert two["base_version"] == 1 and two["removed"] == ["static/old.js"]
        assert all(f["state"] == "available" and f["entry_id"] for f in two["files"])
        assert three["status"] == "failed" and three["files"] == [] and three["folder_id"] is None
        server_one = next(f for f in one["files"] if f["path"] == "server.py")
        server_two = next(f for f in two["files"] if f["path"] == "server.py")
        assert server_two["previous_entry_id"] == server_one["entry_id"]
        assert server_two["author_name"] == engineer.name
        assert server_two["sha256"] == sha256(trees[2]["server.py"].encode()).hexdigest()
        assert (
            next(f for f in two["files"] if f["path"] == "static/app.js")["previous_entry_id"]
            is None
        )

        compared = await diff(
            client, before_entry=server_two["previous_entry_id"], after_entry=server_two["entry_id"]
        )
        assert [(line["kind"], line["text"]) for line in compared["lines"][1:]] == [
            ("remove", "print('one')"),
            ("add", "print('two')"),
        ]

        exported = await client.post("/api/storage/export", json={"entry_ids": [two["folder_id"]]})
        assert exported.status_code == 200, exported.text
        with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
            names = {name for name in archive.namelist() if not name.endswith("/")}
            assert {name.split("Version 2/")[1] for name in names} == set(trees[2])

        # A stored file moved to Trash is reported as such, and stops being comparable.
        assert (await client.delete(f"/api/storage/entries/{server_one['entry_id']}")).is_success
        after = (await client.get("/api/storage/projects/app_dc7")).json()
        assert (
            next(f for f in after["versions"][0]["files"] if f["path"] == "server.py")["state"]
            == "trashed"
        )
        assert (
            next(f for f in after["versions"][1]["files"] if f["path"] == "server.py")[
                "previous_entry_id"
            ]
            is None
        )
        assert (await client.get("/api/storage/projects/app_none")).status_code == 404


async def test_dashboard_reports_real_totals_and_respects_permissions(
    tmp_path: Path, migrated_db_url: str, make_settings: Any, make_client: Any
) -> None:
    runs_dir = tmp_path / "runs"
    wrapper = make_client(
        make_settings(
            NEXUS_DATABASE_URL=migrated_db_url,
            NEXUS_STORAGE_ROOT=tmp_path / "storage",
            NEXUS_RUNS_DIR=runs_dir,
        )
    )
    async with wrapper as client:
        empty = (await client.get("/api/storage/dashboard")).json()
        assert empty["totals"] == {
            "files": 0,
            "folders": 0,
            "trashed": 0,
            "versions": 0,
            "stored_bytes": 0,
            "unavailable_files": 0,
            "error_events": 0,
            "registration_failures": 0,
        }
        assert len(empty["activity"]) == 14
        assert all(day["events"] == 0 for day in empty["activity"])
        assert empty["by_type"] == [] and empty["top_creators"] == []
        assert empty["recent_events"] == []
        assert empty["projects"] == {"apps": 0, "ready_versions": 0, "stored_files": 0}

        kept = await upload(client, "plan.md", b"12345")
        assert (await add_version(client, kept["id"], "plan.md", b"1234567")).is_success
        await client.patch(f"/api/storage/entries/{kept['id']}", json={"artifact_type": "plan"})
        gone = await upload(client, "old.txt", b"abc")
        assert (await client.delete(f"/api/storage/entries/{gone['id']}")).is_success
        await upload(client, "company.txt", b"xy", workspace="/api/storage/workspaces/ws_company")

        database = wrapper.app.state.db
        async with database.sessionmaker() as session:
            engineer = await session.scalar(
                select(Employee).where(Employee.department == "engineering")
            )
            marketer = await session.scalar(
                select(Employee).where(Employee.department == "marketing")
            )
            assert engineer is not None and marketer is not None
            session.add(
                CodeRun(
                    id="run_dc7_missing",
                    language="python",
                    code="print('x')",
                    code_sha256=sha256(b"x").hexdigest(),
                    status="succeeded",
                    employee_id=engineer.id,
                    files=[{"name": "missing.txt", "size": 3}],
                    finished_at=datetime.now(UTC),
                )
            )
            await session.commit()
        registrar = wrapper.app.state.artifacts
        assert (await registrar.register_code_run("run_dc7_missing")).failed == 1
        saved = await registrar.save_text(engineer.id, filename="note.md", content="hello")

        board = (await client.get("/api/storage/dashboard")).json()
        totals = board["totals"]
        assert (totals["files"], totals["trashed"], totals["versions"]) == (3, 1, 5)
        # Every stored version counts toward usage, including history and Trash.
        assert totals["stored_bytes"] == 5 + 7 + 3 + 2 + 5
        assert totals["registration_failures"] == 1 and totals["error_events"] == 1
        engineering = next(w for w in board["workspaces"] if w["id"] == "ws_department:engineering")
        assert engineering["name"] == "Software Engineering"
        assert (engineering["file_count"], engineering["used_bytes"]) == (2, 20)
        assert {row["artifact_type"]: (row["files"], row["bytes"]) for row in board["by_type"]} == {
            "plan": (1, 7),
            "document": (1, 5),
            None: (1, 2),
        }
        assert {row["kind"]: row["files"] for row in board["by_creator"]} == {
            "owner": 2,
            "employee": 1,
        }
        assert board["top_creators"] == [
            {"employee_id": engineer.id, "name": engineer.name, "files": 1}
        ]
        async with database.sessionmaker() as session:
            event_total = len(list(await session.scalars(select(StorageEvent))))
        assert sum(day["events"] for day in board["activity"]) == event_total
        assert sum(day["errors"] for day in board["activity"]) == 1
        assert board["recent_events"][0]["created_at"] >= board["recent_events"][-1]["created_at"]
        assert any(e["kind"] == "artifact_registration_failed" for e in board["recent_events"])
        # Routine bookkeeping stays in each file's own history, not in this short list.
        assert not {e["kind"] for e in board["recent_events"]} & {
            "artifact_linked",
            "entry_updated",
        }
        # Days follow the caller's clock, so "now" is always inside the last day.
        for offset in (-840, 180, 840):
            shifted = (
                await client.get("/api/storage/dashboard", params={"utc_offset_minutes": offset})
            ).json()
            assert shifted["utc_offset_minutes"] == offset
            assert shifted["activity"][-1]["events"] == event_total
        out_of_range = await client.get(
            "/api/storage/dashboard", params={"utc_offset_minutes": 900}
        )
        assert out_of_range.status_code == 422

        # An employee's view is limited to the workspaces they may read.
        insights = VaultInsights(wrapper.app.state.vault)
        async with database.sessionmaker() as session:
            actor = await wrapper.app.state.vault.actor_for_employee(session, marketer.id)
            limited = await insights.dashboard(session, actor=actor)
            assert {w["id"] for w in limited["workspaces"]} == {
                "ws_company",
                "ws_department:marketing",
            }
            assert limited["totals"]["files"] == 1 and limited["totals"]["stored_bytes"] == 2
            assert limited["projects"] is None
            assert limited["totals"]["registration_failures"] == 0
            stored = await session.get(StorageEntry, saved["id"])
            assert stored is not None
            try:
                await insights.projects(session, actor=actor)
            except Exception as error:
                assert getattr(error, "status", None) == 403
            else:
                raise AssertionError("an unrelated employee listed engineering projects")
            try:
                await insights.diff(
                    session,
                    before_entry=kept["id"],
                    before_version=1,
                    after_entry=kept["id"],
                    after_version=2,
                    actor=actor,
                )
            except Exception as error:
                assert getattr(error, "status", None) == 403
            else:
                raise AssertionError("an unrelated employee compared an engineering file")


async def test_an_older_version_recovers_a_file_whose_newest_content_is_lost(
    tmp_path: Path, migrated_db_url: str, make_settings: Any, make_client: Any
) -> None:
    root = tmp_path / "storage"
    wrapper = make_client(
        make_settings(NEXUS_DATABASE_URL=migrated_db_url, NEXUS_STORAGE_ROOT=root)
    )
    async with wrapper as client:
        entry = await upload(client, "report.txt", b"good content\n")
        assert (await add_version(client, entry["id"], "report.txt", b"newer content\n")).is_success
        async with wrapper.app.state.db.sessionmaker() as session:
            newest = await session.scalar(
                select(StorageVersion).where(
                    StorageVersion.entry_id == entry["id"], StorageVersion.number == 2
                )
            )
            assert newest is not None
        (root / newest.storage_key).unlink()

        download = f"/api/storage/entries/{entry['id']}/download"
        assert (await client.get(download)).status_code == 409
        detail = (await client.get(f"/api/storage/entries/{entry['id']}")).json()
        assert detail["status"] == "missing"
        assert [(v["number"], v["status"]) for v in detail["versions"]] == [
            (2, "missing"),
            (1, "available"),
        ]
        # The lost content is reported as lost; the earlier version is still there.
        assert (await client.get(download, params={"version": 1})).content == b"good content\n"
        lost = await client.get(
            "/api/storage/diff",
            params={"before_entry": entry["id"], "before_version": 1, "after_entry": entry["id"]},
        )
        assert lost.status_code == 409

        restored = await client.post(f"/api/storage/entries/{entry['id']}/versions/1/restore")
        assert restored.status_code == 201, restored.text
        assert restored.json()["status"] == "available"
        assert restored.json()["current_version_number"] == 3
        assert (await client.get(download)).content == b"good content\n"
        # Nothing pretends the lost version came back.
        again = await client.post(f"/api/storage/entries/{entry['id']}/versions/2/restore")
        assert again.status_code == 409
        assert (await client.get(download, params={"version": 2})).status_code == 409
