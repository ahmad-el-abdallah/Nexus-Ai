"""Departments, roles, desks and the reporting hierarchy."""

from __future__ import annotations

import json

import httpx

from app.core.office import OFFICE_FILE


async def staff(client: httpx.AsyncClient) -> list[dict]:
    return (await client.get("/api/employees")).json()


async def departments(client: httpx.AsyncClient) -> dict[str, dict]:
    return {d["key"]: d for d in (await client.get("/api/departments")).json()}


def by_name(people: list[dict], name: str) -> dict:
    return next(p for p in people if p["name"] == name)


def chain_to_top(people: list[dict], employee_id: str) -> list[str]:
    index = {p["id"]: p for p in people}
    chain, current = [], employee_id
    while current is not None:
        assert current not in chain, "cycle in the reporting hierarchy"
        chain.append(current)
        current = index[current]["supervisor_id"]
    return chain


# --- Seeded structure --------------------------------------------------------


async def test_all_twenty_departments_exist_in_order(client: httpx.AsyncClient) -> None:
    rows = (await client.get("/api/departments")).json()
    assert len(rows) == 20
    assert [d["position"] for d in rows] == list(range(1, 21))
    assert rows[0]["key"] == "executive"
    for d in rows:
        assert d["roles"] and d["responsibilities"] and d["description"]
        assert d["director_id"], f"{d['key']} has no director"
        assert d["headcount"] >= 1


async def test_every_employee_has_a_valid_role(client: httpx.AsyncClient) -> None:
    depts = await departments(client)
    for person in await staff(client):
        assert person["role"] in depts[person["department"]]["roles"], person["name"]


async def test_hierarchy_is_one_tree_under_the_ceo(client: httpx.AsyncClient) -> None:
    people = await staff(client)
    depts = await departments(client)
    ceo = depts["executive"]["director_id"]
    roots = [p for p in people if p["supervisor_id"] is None]
    assert [r["id"] for r in roots] == [ceo]
    for p in people:
        assert chain_to_top(people, p["id"])[-1] == ceo
    # Directors report to the CEO; staff report to their director.
    for d in depts.values():
        director = next(p for p in people if p["id"] == d["director_id"])
        if d["key"] != "executive":
            assert director["supervisor_id"] == ceo
    priya = by_name(people, "Priya Nair")
    assert priya["supervisor_id"] == depts["sales"]["director_id"]


async def test_departments_without_an_office_have_no_room(client: httpx.AsyncClient) -> None:
    depts = await departments(client)
    with_rooms = {k for k, d in depts.items() if d["room_id"]}
    assert with_rooms == {"executive", "sales", "marketing", "engineering"}


async def test_office_file_lists_unique_desks() -> None:
    data = json.loads(OFFICE_FILE.read_text())
    ids = [d["id"] for d in data["desks"]]
    assert len(ids) == 28 and len(set(ids)) == 28


# --- Hiring --------------------------------------------------------------------


async def test_hire_defaults_to_reporting_to_the_director(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/api/employees",
        json={
            "name": "  Ada   Okoye ",
            "department": "finance",
            "role": "Financial Analyst",
            "seniority": "senior",
        },
    )
    assert response.status_code == 201
    ada = response.json()
    assert ada["name"] == "Ada Okoye"
    assert ada["status"] == "idle"
    assert ada["desk_id"] is None
    assert ada["supervisor_id"] == (await departments(client))["finance"]["director_id"]
    # Persisted and counted.
    assert (await client.get(f"/api/employees/{ada['id']}")).status_code == 200
    assert (await departments(client))["finance"]["headcount"] == 2


async def test_hire_rejects_invalid_roles_desks_and_departments(client: httpx.AsyncClient) -> None:
    bad_role = await client.post(
        "/api/employees",
        json={"name": "X Y", "department": "finance", "role": "Frontend Developer"},
    )
    assert bad_role.status_code == 422
    assert "not a role" in bad_role.json()["detail"]
    bad_dept = await client.post(
        "/api/employees", json={"name": "X Y", "department": "nope", "role": "Analyst"}
    )
    assert bad_dept.status_code == 422
    bad_desk = await client.post(
        "/api/employees",
        json={
            "name": "X Y",
            "department": "sales",
            "role": "Account Executive",
            "desk_id": "moon-desk-1",
        },
    )
    assert bad_desk.status_code == 422
    taken = await client.post(
        "/api/employees",
        json={
            "name": "X Y",
            "department": "sales",
            "role": "Account Executive",
            "desk_id": "sales-desk-1",
        },
    )
    assert taken.status_code == 409
    seniority = await client.post(
        "/api/employees",
        json={
            "name": "X Y",
            "department": "sales",
            "role": "Account Executive",
            "seniority": "wizard",
        },
    )
    assert seniority.status_code == 422
    unknown_field = await client.post(
        "/api/employees",
        json={"name": "X Y", "department": "sales", "role": "Account Executive", "salary": 1},
    )
    assert unknown_field.status_code == 422


async def test_hire_at_a_free_desk(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/api/employees",
        json={
            "name": "Jo Smith",
            "department": "sales",
            "role": "Account Executive",
            "desk_id": "sales-desk-4",
        },
    )
    assert response.status_code == 201
    assert response.json()["desk_id"] == "sales-desk-4"


# --- Editing & reassignment ----------------------------------------------------


async def test_move_department_requires_a_valid_role_and_rewires_reporting(
    client: httpx.AsyncClient,
) -> None:
    people = await staff(client)
    noah = by_name(people, "Noah Fischer")
    wrong = await client.patch(f"/api/employees/{noah['id']}", json={"department": "research"})
    assert wrong.status_code == 422  # "Marketing Strategist" isn't a research role
    moved = await client.patch(
        f"/api/employees/{noah['id']}", json={"department": "research", "role": "Trend Analyst"}
    )
    assert moved.status_code == 200
    body = moved.json()
    assert body["department"] == "research"
    assert body["supervisor_id"] == (await departments(client))["research"]["director_id"]


async def test_director_leaving_clears_the_department_director(client: httpx.AsyncClient) -> None:
    people = await staff(client)
    marcus = by_name(people, "Marcus Bell")  # Sales Director
    moved = await client.patch(
        f"/api/employees/{marcus['id']}",
        json={"department": "marketing", "role": "Growth Specialist"},
    )
    assert moved.status_code == 200
    depts = await departments(client)
    assert depts["sales"]["director_id"] is None
    # His former reports now report to the CEO, so the tree stays whole.
    people = await staff(client)
    priya = by_name(people, "Priya Nair")
    assert priya["supervisor_id"] == depts["executive"]["director_id"]


async def test_reporting_cycles_and_self_supervision_are_rejected(
    client: httpx.AsyncClient,
) -> None:
    people = await staff(client)
    iris = by_name(people, "Iris Wong")  # CTO
    felix = by_name(people, "Felix Schmidt")  # reports to Iris
    assert (
        await client.patch(f"/api/employees/{iris['id']}", json={"supervisor_id": felix["id"]})
    ).status_code == 422
    assert (
        await client.patch(f"/api/employees/{felix['id']}", json={"supervisor_id": felix["id"]})
    ).status_code == 422
    ceo = (await departments(client))["executive"]["director_id"]
    assert (
        await client.patch(f"/api/employees/{ceo}", json={"supervisor_id": iris["id"]})
    ).status_code == 422
    assert (
        await client.patch(f"/api/employees/{felix['id']}", json={"supervisor_id": None})
    ).status_code == 422


async def test_reseat_and_unseat(client: httpx.AsyncClient) -> None:
    grace = by_name(await staff(client), "Grace Liu")
    seated = await client.patch(
        f"/api/employees/{grace['id']}", json={"desk_id": "engineering-desk-12"}
    )
    assert seated.status_code == 200 and seated.json()["desk_id"] == "engineering-desk-12"
    clash = by_name(await staff(client), "Tomás Herrera")
    assert (
        await client.patch(f"/api/employees/{clash['id']}", json={"desk_id": "engineering-desk-12"})
    ).status_code == 409
    unseated = await client.patch(f"/api/employees/{grace['id']}", json={"desk_id": None})
    assert unseated.json()["desk_id"] is None


async def test_rename_and_change_role_within_department(client: httpx.AsyncClient) -> None:
    lucas = by_name(await staff(client), "Lucas Martin")
    edited = await client.patch(
        f"/api/employees/{lucas['id']}",
        json={"name": "Lucas Marin", "role": "Content Strategist", "seniority": "senior"},
    )
    assert edited.status_code == 200
    assert edited.json()["name"] == "Lucas Marin" and edited.json()["role"] == "Content Strategist"


async def test_ceo_cannot_leave_or_be_removed(client: httpx.AsyncClient) -> None:
    ceo = (await departments(client))["executive"]["director_id"]
    assert (
        await client.patch(
            f"/api/employees/{ceo}", json={"department": "sales", "role": "Sales Director"}
        )
    ).status_code == 422
    assert (await client.delete(f"/api/employees/{ceo}")).status_code == 409


async def test_removing_a_manager_moves_reports_up(client: httpx.AsyncClient) -> None:
    people = await staff(client)
    iris = by_name(people, "Iris Wong")
    ceo = (await departments(client))["executive"]["director_id"]
    assert (await client.delete(f"/api/employees/{iris['id']}")).status_code == 204
    assert (await client.get(f"/api/employees/{iris['id']}")).status_code == 404
    people = await staff(client)
    felix = by_name(people, "Felix Schmidt")
    assert felix["supervisor_id"] == ceo
    assert (await departments(client))["engineering"]["director_id"] is None


# --- Department configuration ---------------------------------------------------


async def test_configure_department_persists(client: httpx.AsyncClient) -> None:
    response = await client.patch(
        "/api/departments/quality-assurance",
        json={
            "name": "Quality & Testing",
            "color": "#14b8a6",
            "room_id": "engineering",
            "max_concurrent_tasks": 4,
            "daily_request_budget": 500,
        },
    )
    assert response.status_code == 200
    qa = (await client.get("/api/departments/quality-assurance")).json()
    assert qa["name"] == "Quality & Testing"
    assert qa["room_id"] == "engineering"
    assert (qa["max_concurrent_tasks"], qa["daily_request_budget"]) == (4, 500)


async def test_configure_department_validation(client: httpx.AsyncClient) -> None:
    assert (
        await client.patch("/api/departments/finance", json={"room_id": "cafe"})
    ).status_code == 422
    assert (
        await client.patch("/api/departments/finance", json={"room_id": "data-center"})
    ).status_code == 422
    assert (
        await client.patch("/api/departments/finance", json={"color": "red"})
    ).status_code == 422
    assert (
        await client.patch("/api/departments/finance", json={"max_concurrent_tasks": 0})
    ).status_code == 422
    assert (await client.patch("/api/departments/finance", json={"name": "X"})).status_code == 422
    assert (await client.patch("/api/departments/nope", json={"name": "Valid"})).status_code == 404
    outsider = by_name(await staff(client), "Priya Nair")
    assert (
        await client.patch("/api/departments/finance", json={"director_id": outsider["id"]})
    ).status_code == 422
    assert (
        await client.patch("/api/departments/executive", json={"director_id": None})
    ).status_code == 422


async def test_appointing_a_director_rewires_the_team(client: httpx.AsyncClient) -> None:
    people = await staff(client)
    priya = by_name(people, "Priya Nair")
    marcus = by_name(people, "Marcus Bell")
    ceo = (await departments(client))["executive"]["director_id"]
    response = await client.patch("/api/departments/sales", json={"director_id": priya["id"]})
    assert response.status_code == 200
    people = await staff(client)
    assert by_name(people, "Priya Nair")["supervisor_id"] == ceo
    assert by_name(people, "Marcus Bell")["supervisor_id"] == priya["id"]
    assert by_name(people, "Diego Alvarez")["supervisor_id"] == priya["id"]
    for p in people:
        chain_to_top(people, p["id"])
    assert marcus["id"] != priya["id"]


async def test_appointing_a_new_ceo_keeps_one_tree(client: httpx.AsyncClient) -> None:
    people = await staff(client)
    leo = by_name(people, "Leo Park")  # Executive Assistant
    old_ceo = (await departments(client))["executive"]["director_id"]
    assert (
        await client.patch("/api/departments/executive", json={"director_id": leo["id"]})
    ).status_code == 200
    people = await staff(client)
    roots = [p for p in people if p["supervisor_id"] is None]
    assert [r["id"] for r in roots] == [leo["id"]]
    assert by_name(people, "Aria Vance")["supervisor_id"] == leo["id"]
    for p in people:
        assert chain_to_top(people, p["id"])[-1] == leo["id"]
    assert old_ceo != leo["id"]
