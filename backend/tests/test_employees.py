from __future__ import annotations

import re

import httpx

SEATED_DEPARTMENTS = {"executive", "sales", "marketing", "engineering"}


async def test_lists_the_seeded_staff(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/employees")
    assert response.status_code == 200
    staff = response.json()
    assert len(staff) == 35
    assert len({e["department"] for e in staff}) == 20
    seated = [e for e in staff if e["desk_id"]]
    assert len(seated) == 19
    assert {e["department"] for e in seated} == SEATED_DEPARTMENTS
    ids = [e["id"] for e in staff]
    assert len(set(ids)) == len(ids)
    assert all(re.fullmatch(r"emp_[0-9a-f]{12}", i) for i in ids)
    desks = [e["desk_id"] for e in seated]
    assert len(set(desks)) == len(desks), "no two employees share a desk"
    # Nobody is doing work: there is no task system yet.
    assert {e["status"] for e in staff} == {"idle"}


async def test_get_one_and_unknown(client: httpx.AsyncClient) -> None:
    first = (await client.get("/api/employees")).json()[0]
    one = await client.get(f"/api/employees/{first['id']}")
    assert one.status_code == 200
    assert one.json()["name"] == first["name"]
    missing = await client.get("/api/employees/emp_000000000000")
    assert missing.status_code == 404


async def test_suspend_and_activate_round_trip(client: httpx.AsyncClient) -> None:
    emp = (await client.get("/api/employees")).json()[0]
    suspended = await client.post(f"/api/employees/{emp['id']}/suspend")
    assert suspended.status_code == 200
    body = suspended.json()
    assert body["status"] == "suspended"
    assert body["status_detail"] == "Suspended by the owner"
    assert body["status_changed_at"] >= emp["status_changed_at"]

    # Persisted, not just echoed.
    again = (await client.get(f"/api/employees/{emp['id']}")).json()
    assert again["status"] == "suspended"

    twice = await client.post(f"/api/employees/{emp['id']}/suspend")
    assert twice.status_code == 409

    activated = await client.post(f"/api/employees/{emp['id']}/activate")
    assert activated.status_code == 200
    assert activated.json()["status"] == "idle"
    assert activated.json()["status_detail"] is None


async def test_activate_requires_suspension(client: httpx.AsyncClient) -> None:
    emp = (await client.get("/api/employees")).json()[0]
    response = await client.post(f"/api/employees/{emp['id']}/activate")
    assert response.status_code == 409


async def test_status_actions_on_unknown_employee(client: httpx.AsyncClient) -> None:
    for action in ("suspend", "activate"):
        response = await client.post(f"/api/employees/emp_000000000000/{action}")
        assert response.status_code == 404
