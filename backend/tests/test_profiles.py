"""Employee profiles: identity, skills, evidence-based performance, ratings, history."""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from sqlalchemy import select

from app.main import create_app
from app.models import CodeRun, Employee, Task


@pytest.fixture
async def http(migrated_db_url: str, make_settings: Any) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(make_settings(NEXUS_DATABASE_URL=migrated_db_url))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client,
    ):
        client.app = app  # type: ignore[attr-defined]
        yield client


async def by_name(client: httpx.AsyncClient, name: str) -> dict[str, Any]:
    roster = (await client.get("/api/employees")).json()
    return next(e for e in roster if e["name"] == name)


async def add_task(
    client: httpx.AsyncClient, assignee: str, status: str, revisions: int = 0
) -> None:
    app = client.app  # type: ignore[attr-defined]
    async with app.state.db.sessionmaker() as session:
        emp = await session.scalar(select(Employee).where(Employee.id == assignee))
        session.add(
            Task(
                id=f"tsk_{status}_{revisions}_{id(status) % 100000}",
                title=f"Task {status}",
                description="",
                department=emp.department,
                assignee_id=assignee,
                status=status,
                kind="work",
                revisions=revisions,
                finished_at=datetime.now(UTC) if status in ("done", "failed") else None,
            )
        )
        await session.commit()


async def add_run(client: httpx.AsyncClient, employee_id: str, status: str) -> None:
    app = client.app  # type: ignore[attr-defined]
    async with app.state.db.sessionmaker() as session:
        session.add(
            CodeRun(
                id=f"run_{status}_{id(status) % 100000}",
                language="python",
                code="print(1)",
                code_sha256="x" * 64,
                status=status,
                employee_id=employee_id,
            )
        )
        await session.commit()


async def test_profile_opens_with_identity_and_no_invented_metrics(
    http: httpx.AsyncClient,
) -> None:
    priya = await by_name(http, "Priya Nair")
    p = (await http.get(f"/api/employees/{priya['id']}/profile")).json()
    assert p["name"] == "Priya Nair"
    assert p["department_name"] == "Sales"
    assert p["manager"]["name"] == "Marcus Bell"
    assert p["skills"] == []
    # No activity yet: performance is unknown, not a made-up number.
    assert p["performance"]["success_rate"] is None
    assert p["performance"]["finished_items"] == 0
    assert "No finished tasks or runs yet" in p["performance"]["basis"]
    assert p["rating"] == {"average": None, "count": 0}
    assert p["task_history"] == [] and p["active_assignments"] == []


async def test_performance_is_computed_from_real_tasks_and_runs(http: httpx.AsyncClient) -> None:
    diego = await by_name(http, "Diego Alvarez")
    await add_task(http, diego["id"], "done")
    await add_task(http, diego["id"], "done", revisions=2)
    await add_task(http, diego["id"], "failed")
    await add_task(http, diego["id"], "running")  # active, not counted as finished
    await add_run(http, diego["id"], "succeeded")
    await add_run(http, diego["id"], "timed_out")
    p = (await http.get(f"/api/employees/{diego['id']}/profile")).json()
    perf = p["performance"]
    assert perf["tasks_done"] == 2 and perf["tasks_failed"] == 1
    assert perf["revisions_requested"] == 2
    assert perf["runs_succeeded"] == 1 and perf["runs_failed"] == 1
    assert perf["finished_items"] == 5  # 3 finished tasks + 2 finished runs
    assert perf["success_rate"] == 60  # (2 done + 1 run ok) / 5
    assert len(p["active_assignments"]) == 1 and p["active_assignments"][0]["status"] == "running"
    assert len(p["task_history"]) == 3  # the finished tasks


async def test_skills_are_owner_managed_and_deduped(http: httpx.AsyncClient) -> None:
    emp = await by_name(http, "Felix Schmidt")
    r = await http.patch(
        f"/api/employees/{emp['id']}", json={"skills": ["Python", "python ", "  APIs  ", ""]}
    )
    assert r.status_code == 200
    assert r.json()["skills"] == ["Python", "APIs"]
    assert (await http.get(f"/api/employees/{emp['id']}/profile")).json()["skills"] == [
        "Python",
        "APIs",
    ]
    roster_entry = await by_name(http, "Felix Schmidt")
    assert roster_entry["skills"] == ["Python", "APIs"]


async def test_owner_ratings_and_feedback_with_history(http: httpx.AsyncClient) -> None:
    emp = await by_name(http, "Hana Kobayashi")
    bad = await http.post(f"/api/employees/{emp['id']}/feedback", json={})
    assert bad.status_code == 422
    assert (
        await http.post(f"/api/employees/{emp['id']}/feedback", json={"rating": 9})
    ).status_code == 422
    await http.post(
        f"/api/employees/{emp['id']}/feedback", json={"rating": 4, "note": "Solid work"}
    )
    p = (await http.post(f"/api/employees/{emp['id']}/feedback", json={"rating": 2})).json()
    assert p["rating"] == {"average": 3.0, "count": 2}
    assert len(p["feedback"]) == 2
    assert p["feedback"][0]["rating"] == 2  # newest first
    assert any(f["note"] == "Solid work" for f in p["feedback"])
    assert any("Owner feedback: 4/5" in h["text"] for h in p["history"])
    first = next(f for f in p["feedback"] if f["note"] == "Solid work")
    assert (
        await http.delete(f"/api/employees/{emp['id']}/feedback/{first['id']}")
    ).status_code == 204
    after = (await http.get(f"/api/employees/{emp['id']}/profile")).json()
    assert after["rating"]["count"] == 1 and after["rating"]["average"] == 2.0


async def test_changes_and_hiring_are_recorded_in_history(http: httpx.AsyncClient) -> None:
    hired = (
        await http.post(
            "/api/employees",
            json={"name": "Nadia Scanner", "department": "sales", "role": "Account Executive"},
        )
    ).json()
    p = (await http.get(f"/api/employees/{hired['id']}/profile")).json()
    assert any(h["kind"] == "hired" for h in p["history"])
    await http.patch(
        f"/api/employees/{hired['id']}", json={"role": "Sales Development Representative"}
    )
    await http.post(f"/api/employees/{hired['id']}/suspend")
    p = (await http.get(f"/api/employees/{hired['id']}/profile")).json()
    kinds = [h["kind"] for h in p["history"]]
    assert "role_changed" in kinds and "suspended" in kinds
    role_change = next(h for h in p["history"] if h["kind"] == "role_changed")
    assert "Sales Development Representative" in role_change["text"]
