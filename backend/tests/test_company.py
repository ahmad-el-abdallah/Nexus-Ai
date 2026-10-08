"""Employees know their company like in a real one: live records, access by position."""

from __future__ import annotations

import json
from typing import Any

import httpx
from sqlalchemy import select

from app.models import Employee, Task
from app.services.company import MAX_CHARS, company_briefing, level_of
from tests import test_chat
from tests.test_chat import app_of, open_chat, settle

# Same app as the chat tests (fake AI provider, migrated database).
fake = test_chat.fake
chat_client = test_chat.chat_client


async def briefing_for(client: httpx.AsyncClient, name: str) -> str:
    async with app_of(client).state.db.sessionmaker() as session:
        employee = await session.scalar(select(Employee).where(Employee.name == name))
        return await company_briefing(session, employee)


async def add_task(client: httpx.AsyncClient, assignee: str, title: str, status: str) -> None:
    async with app_of(client).state.db.sessionmaker() as session:
        employee = await session.scalar(select(Employee).where(Employee.name == assignee))
        session.add(
            Task(
                id=f"tsk_{abs(hash(title)) % 10**10}",
                title=title,
                description="",
                department=employee.department,
                assignee_id=employee.id,
                status=status,
                kind="manual" if status == "open" else "work",
            )
        )
        await session.commit()


async def test_a_director_knows_their_team_and_its_work(chat_client: httpx.AsyncClient) -> None:
    await add_task(chat_client, "Priya Nair", "Prospect list for Q4", "running")
    await add_task(chat_client, "Diego Alvarez", "Renewal proposal", "done")
    text = await briefing_for(chat_client, "Marcus Bell")
    assert "access level: director" in text
    assert "your direct reports: Diego Alvarez, Hana Kobayashi, Priya Nair, Samuel Okafor" in text
    priya = next(line for line in text.splitlines() if line.startswith("- Priya Nair"))
    assert "Sales Development Representative" in priya and "female" in priya
    assert "“Prospect list for Q4” (running)" in priya
    diego = next(line for line in text.splitlines() if line.startswith("- Diego Alvarez"))
    assert "record: 1 task(s) completed, 0 failed" in diego
    assert "WORKFLOWS INVOLVING SALES" in text
    # The whole company directory, but not other teams' people.
    assert "- Marketing (key: marketing) — director: Elena Rossi" in text
    assert "- Noah Fischer" not in text
    assert "Do not say you lack access" in text


async def test_staff_see_their_team_but_not_its_track_record(
    chat_client: httpx.AsyncClient,
) -> None:
    text = await briefing_for(chat_client, "Priya Nair")
    assert "access level: staff" in text
    assert "you report to Marcus Bell (Sales Director)" in text
    assert "- Diego Alvarez" in text and "record:" not in text
    assert "WORKFLOWS" not in text and "EMAIL:" not in text


async def test_the_ceo_knows_every_department(chat_client: httpx.AsyncClient) -> None:
    await add_task(chat_client, "Noah Fischer", "Campaign brief", "running")
    text = await briefing_for(chat_client, "Aria Vance")
    assert "access level: executive management — the whole company" in text
    assert "- Noah Fischer" in text and "“Campaign brief” (running)" in text
    assert "- Fatima Zahra" in text and "remote (no desk in the building)" in text
    assert "WORKFLOWS (objectives the owner gave the CEO)" in text
    assert "EMAIL: 0 connected account(s); 0 draft(s) waiting" in text
    assert "1 unfinished task(s)" in text  # Marketing's line in the directory
    assert len(text) <= MAX_CHARS + 40


async def test_levels_follow_position(chat_client: httpx.AsyncClient) -> None:
    async with app_of(chat_client).state.db.sessionmaker() as session:
        from app.models import Department

        departments = list(await session.scalars(select(Department)))
        people = {e.name: e for e in await session.scalars(select(Employee))}
    assert level_of(people["Aria Vance"], departments) == "executive"
    assert level_of(people["Leo Park"], departments) == "executive"
    assert level_of(people["Fatima Zahra"], departments) == "director"
    assert level_of(people["Samuel Okafor"], departments) == "staff"


async def test_the_briefing_reaches_the_model_in_chat(
    chat_client: httpx.AsyncClient, fake: Any
) -> None:
    cid = await open_chat(chat_client, department="sales")
    r = await chat_client.post(
        f"/api/conversations/{cid}/messages", data={"content": "Who is on your team?"}
    )
    assert r.status_code in (200, 201, 202), r.text
    await settle(chat_client, cid)
    system = json.loads(fake.calls[-1].content)["messages"][0]["content"]
    assert "You are Marcus Bell" in system
    assert "YOUR TEAM:" in system and "- Hana Kobayashi" in system
    assert "COMPANY DIRECTORY" in system
