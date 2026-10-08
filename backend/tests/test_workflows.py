"""Multi-agent orchestration: delegation, approval, review, retries, failures, limits."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from sqlalchemy import select

from app.main import create_app
from app.models import AIUsage, Task, Workflow
from app.orchestration import plans
from tests.fake_agents import canned_reply
from tests.test_ai import FAKE_KEY, MASTER, _no_sleep, ready_catalog

FORMATS = ("PLAN", "BREAKDOWN", "WORK", "REVIEW", "SUMMARY", "REPORT")
OBJECTIVE = "Research a new software business opportunity and create an implementation plan."


class AgentProvider:
    """OpenAI-compatible fake whose replies follow each workflow step's format.
    `script[format]` holds overrides consumed in order: "invalid", "empty", "revise",
    an HTTP status, a JSON string, or ("slow", seconds)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []  # (format, prompt)
        self.script: dict[str, list[Any]] = {}
        self.delay = 0.0

    def on(self, fmt: str, *actions: Any) -> None:
        self.script.setdefault(fmt, []).extend(actions)

    def count(self, fmt: str) -> int:
        return sum(f == fmt for f, _ in self.calls)

    async def handler(self, request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization") != f"Bearer {FAKE_KEY}":
            return httpx.Response(401, json={"title": "Unauthorized"})
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "acme/fast-chat", "object": "model"}]})
        body = json.loads(request.content)
        prompt = body["messages"][-1]["content"]
        fmt = next((f for f in FORMATS if f"Format: NEXUS-{f}/1" in prompt), "CHAT")
        self.calls.append((fmt, prompt))
        if self.delay:
            await asyncio.sleep(self.delay)
        planned = self.script.get(fmt, [])
        action = planned.pop(0) if planned else None
        if isinstance(action, tuple) and action[0] == "slow":
            await asyncio.sleep(action[1])
            action = None
        if isinstance(action, int):
            return httpx.Response(action, json={"detail": f"status {action}"})
        if action == "invalid":
            content: str | None = "Sure! Here is my plan: first we research, then we build."
        elif action == "empty":
            content = None
        elif action == "revise":
            content = json.dumps({"decision": "revise", "feedback": "Add concrete next steps."})
        elif isinstance(action, str):
            content = action
        else:
            content = canned_reply(prompt) or "ok"
        return httpx.Response(
            200,
            json={
                "model": body["model"],
                "choices": [{"message": {"content": content}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 100, "completion_tokens": 50},
            },
        )


@pytest.fixture
def agents() -> AgentProvider:
    return AgentProvider()


@pytest.fixture
async def wf_client(
    migrated_db_url: str, make_settings: Any, agents: AgentProvider
) -> AsyncIterator[httpx.AsyncClient]:
    settings = make_settings(
        NEXUS_DATABASE_URL=migrated_db_url, NVIDIA_API_KEY=FAKE_KEY, NEXUS_SECRET_KEY=MASTER
    )
    app = create_app(settings, ai_transport=httpx.MockTransport(agents.handler))
    async with app.router.lifespan_context(app):
        app.state.ai.sleep = _no_sleep
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as http:
            http.app = app  # type: ignore[attr-defined]
            await ready_catalog(http)
            yield http
            await app.state.workflows.shutdown()


async def wait_for(
    client: httpx.AsyncClient, wid: str, *statuses: str, within: float = 10
) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + within
    while True:
        data = (await client.get(f"/api/workflows/{wid}")).json()
        if data["status"] in statuses:
            return data
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(f"workflow stuck in {data['status']}: {data.get('status_reason')}")
        await asyncio.sleep(0.02)


async def start(
    client: httpx.AsyncClient, objective: str = OBJECTIVE, **extra: Any
) -> dict[str, Any]:
    r = await client.post("/api/workflows", json={"objective": objective, **extra})
    assert r.status_code == 201, r.text
    return await wait_for(client, r.json()["id"], "awaiting_approval", "failed")


def kinds(data: dict[str, Any]) -> list[str]:
    return [e["kind"] for e in data["events"]]


def by_department(data: dict[str, Any], kind: str = "assignment") -> dict[str, dict[str, Any]]:
    return {t["department"]: t for t in data["tasks"] if t["kind"] == kind}


# --------------------------------------------------------------- happy path


async def test_ceo_delegates_departments_execute_and_results_are_consolidated(
    wf_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    plan = await start(wf_client)
    assert plan["status"] == "awaiting_approval"
    assert agents.count("PLAN") == 1 and len(agents.calls) == 1  # nothing else ran yet
    assignments = by_department(plan)
    assert set(assignments) == {"research", "engineering"}
    assert all(a["status"] == "proposed" for a in assignments.values())
    assert assignments["engineering"]["depends_on"] == [assignments["research"]["id"]]
    assert plan["estimate"]["typical"] >= 7

    r = await wf_client.post(f"/api/workflows/{plan['id']}/approve", json={})
    assert r.status_code == 200
    done = await wait_for(wf_client, plan["id"], "completed", "partial", "failed")
    assert done["status"] == "completed", done["status_reason"]
    assert done["result"].startswith("## Summary")

    a = by_department(done)
    assert a["research"]["status"] == "done" and a["engineering"]["status"] == "done"
    work = [t for t in done["tasks"] if t["kind"] == "work"]
    eng_work = [t for t in work if t["department"] == "engineering"]
    assert len(eng_work) == 2  # supervisor split the assignment between two people
    assert len({t["assignee_id"] for t in eng_work}) == 2
    assert all(t["status"] == "done" and t["result"] for t in work)
    # Reviews are counted as requests on the task, not as extra attempts.
    assert all(t["attempts"] == 1 for t in work)
    assert all(t["calls"] == 2 for t in eng_work)

    # Dependency order: research finished before engineering started planning.
    order = [fmt for fmt, _ in agents.calls]
    assert order[0] == "PLAN"
    assert order.index("BREAKDOWN") > order.index("WORK")
    breakdown_prompt = next(p for f, p in agents.calls if f == "BREAKDOWN")
    assert "HANDOFF from Market Research & Innovation" in breakdown_prompt
    # Engineering's two tasks were each reviewed, then summarised; one CEO report.
    assert agents.count("REVIEW") == 2
    assert agents.count("SUMMARY") == 1
    assert agents.count("REPORT") == 1
    assert done["calls_used"] == len(agents.calls) == 9

    ev = kinds(done)
    for k in (
        "created",
        "plan_proposed",
        "approved",
        "delegated",
        "handoff",
        "assigned",
        "delivered",
        "approved_work",
        "department_done",
        "completed",
    ):
        assert k in ev, k
    handoff = next(e for e in done["events"] if e["kind"] == "handoff")
    assert (handoff["from_department"], handoff["to_department"]) == ("research", "engineering")

    async with wf_client.app.state.db.sessionmaker() as session:  # type: ignore[attr-defined]
        purposes = sorted({u.purpose for u in await session.scalars(select(AIUsage))})
    assert {
        "workflow_plan",
        "workflow_breakdown",
        "workflow_work",
        "workflow_review",
        "workflow_summary",
        "workflow_report",
    } <= set(purposes)


async def test_nothing_runs_without_approval_and_the_owner_can_trim_the_plan(
    wf_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    plan = await start(wf_client)
    await asyncio.sleep(0.2)
    assert len(agents.calls) == 1
    research = by_department(plan)["research"]["id"]
    assert (await wf_client.post(f"/api/workflows/{plan['id']}/resume")).status_code == 409
    all_ids = [t["id"] for t in plan["tasks"]]
    assert (
        await wf_client.post(f"/api/workflows/{plan['id']}/approve", json={"exclude": all_ids})
    ).status_code == 422
    r = await wf_client.post(f"/api/workflows/{plan['id']}/approve", json={"exclude": [research]})
    assert r.status_code == 200
    assert (
        await wf_client.post(f"/api/workflows/{plan['id']}/approve", json={})
    ).status_code == 409
    done = await wait_for(wf_client, plan["id"], "completed", "partial", "failed")
    assert done["status"] == "completed"
    a = by_department(done)
    assert a["research"]["status"] == "cancelled"
    assert a["engineering"]["depends_on"] == []
    assert a["engineering"]["status"] == "done"
    assert not any(f == "WORK" and "Market Research" in p for f, p in agents.calls)


# -------------------------------------------------------- retries & validation


async def test_unusable_plan_is_retried_with_feedback(
    wf_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    bad = json.dumps(
        {
            "summary": "x" * 10,
            "assignments": [
                {
                    "id": "a1",
                    "department": "spaceships",
                    "title": "Build",
                    "instructions": "Build a spaceship now.",
                    "depends_on": [],
                }
            ],
        }
    )
    agents.on("PLAN", bad)
    plan = await start(wf_client)
    assert plan["status"] == "awaiting_approval"
    retry_prompt = [p for f, p in agents.calls if f == "PLAN"][1]
    assert "Unknown or unavailable department 'spaceships'" in retry_prompt
    assert "retry" in kinds(plan)


async def test_plan_that_stays_unusable_fails_clearly_and_can_be_retried(
    wf_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    agents.on("PLAN", "invalid", "invalid")
    failed = await start(wf_client)
    assert failed["status"] == "failed"
    assert "plan could not be used" in failed["status_reason"]
    await wf_client.post(f"/api/workflows/{failed['id']}/resume")
    again = await wait_for(wf_client, failed["id"], "awaiting_approval", "failed")
    assert again["status"] == "awaiting_approval"


async def test_review_requests_one_revision_and_never_loops(
    wf_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    agents.on("REVIEW", "revise", "revise", "revise", "revise")
    plan = await start(wf_client)
    await wf_client.post(f"/api/workflows/{plan['id']}/approve", json={})
    done = await wait_for(wf_client, plan["id"], "completed", "partial", "failed")
    assert done["status"] == "completed"
    eng = [t for t in done["tasks"] if t["kind"] == "work" and t["department"] == "engineering"]
    assert all(t["revisions"] == 1 for t in eng)
    assert all(
        t["review_notes"].startswith("Accepted after the maximum of 1 revision") for t in eng
    )
    assert agents.count("REVIEW") == 4  # two reviews per task, then forced acceptance
    revision_prompts = [p for f, p in agents.calls if f == "WORK" and "SUPERVISOR FEEDBACK" in p]
    assert len(revision_prompts) == 2
    assert "Add concrete next steps." in revision_prompts[0]
    assert kinds(done).count("revision_requested") == 2


async def test_transient_errors_are_retried(
    wf_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    agents.on("WORK", "empty")  # e.g. a reasoning model used all tokens
    plan = await start(wf_client)
    await wf_client.post(f"/api/workflows/{plan['id']}/approve", json={})
    done = await wait_for(wf_client, plan["id"], "completed", "partial", "failed")
    assert done["status"] == "completed"
    research_work = by_department(done, "work")["research"]
    assert research_work["attempts"] == 2
    assert any("no visible text" in e["text"] for e in done["events"] if e["kind"] == "retry")


# ------------------------------------------------------------------ failures


async def test_failed_dependency_skips_dependents_and_failure_is_reported(
    wf_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    agents.on("WORK", *([500] * 6))  # research work fails on both attempts (incl. gateway retries)
    plan = await start(wf_client)
    await wf_client.post(f"/api/workflows/{plan['id']}/approve", json={})
    done = await wait_for(wf_client, plan["id"], "completed", "partial", "failed")
    assert done["status"] == "failed"
    assert "No department produced a result" in done["status_reason"]
    a = by_department(done)
    assert a["research"]["status"] == "failed"
    assert a["engineering"]["status"] == "skipped"
    assert "did not complete" in a["engineering"]["error"]
    assert {"failed", "skipped", "workflow_failed"} <= set(kinds(done))
    assert agents.count("BREAKDOWN") == 0 and agents.count("REPORT") == 0


async def test_independent_departments_finish_and_the_report_lists_what_failed(
    wf_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    plan_json = json.dumps(
        {
            "summary": "Two independent streams.",
            "assignments": [
                {
                    "id": "a1",
                    "department": "research",
                    "title": "Market scan",
                    "instructions": "Scan the market briefly.",
                    "depends_on": [],
                },
                {
                    "id": "a2",
                    "department": "finance",
                    "title": "Cost model",
                    "instructions": "Estimate costs briefly.",
                    "depends_on": [],
                },
            ],
            "deliverable": "Report",
        }
    )
    agents.on("PLAN", plan_json)
    original = agents.handler

    async def fail_research_work(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else {}
        prompt = (body.get("messages") or [{}])[-1].get("content", "")
        if "Format: NEXUS-WORK/1" in prompt and "Market scan" in prompt:
            agents.calls.append(("WORK", prompt))
            return httpx.Response(400, json={"detail": "bad request"})
        return await original(request)

    agents.handler = fail_research_work  # type: ignore[method-assign]
    wf_client.app.state.ai.transport = httpx.MockTransport(fail_research_work)  # type: ignore[attr-defined]
    plan = await start(wf_client)
    await wf_client.post(f"/api/workflows/{plan['id']}/approve", json={})
    done = await wait_for(wf_client, plan["id"], "completed", "partial", "failed")
    assert done["status"] == "partial"
    assert by_department(done)["finance"]["status"] == "done"
    assert by_department(done)["research"]["status"] == "failed"
    report_prompt = next(p for f, p in agents.calls if f == "REPORT")
    assert "Not completed:\n- Market Research & Innovation — Market scan" in report_prompt


# ----------------------------------------------------- cancel, pause, limits


async def test_cancel_stops_everything(wf_client: httpx.AsyncClient, agents: AgentProvider) -> None:
    plan = await start(wf_client)
    agents.delay = 0.5
    await wf_client.post(f"/api/workflows/{plan['id']}/approve", json={})
    await asyncio.sleep(0.1)
    r = await wf_client.post(f"/api/workflows/{plan['id']}/cancel")
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "cancelled"
    assert all(t["status"] == "cancelled" for t in data["tasks"])
    calls = len(agents.calls)
    await asyncio.sleep(0.8)
    assert len(agents.calls) == calls
    roster = (await wf_client.get("/api/employees")).json()
    assert not [e for e in roster if e["status"] in ("working", "reviewing", "assigned")]
    assert (await wf_client.post(f"/api/workflows/{plan['id']}/cancel")).status_code == 409


async def test_budget_exhaustion_pauses_and_resume_continues(
    wf_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    plan = await start(wf_client)
    await wf_client.patch("/api/ai/settings", json={"daily_request_budget": len(agents.calls) + 2})
    await wf_client.post(f"/api/workflows/{plan['id']}/approve", json={})
    paused = await wait_for(wf_client, plan["id"], "paused", "failed", "completed")
    assert paused["status"] == "paused"
    assert "daily AI request budget" in paused["status_reason"]
    assert not any(
        t["status"] in ("running", "reviewing", "planning", "summarizing") for t in paused["tasks"]
    )
    await wf_client.patch("/api/ai/settings", json={"daily_request_budget": 500})
    await wf_client.post(f"/api/workflows/{plan['id']}/resume")
    done = await wait_for(wf_client, plan["id"], "completed", "partial", "failed")
    assert done["status"] == "completed"


async def test_safety_limit_on_model_requests(
    wf_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    plan = await start(wf_client, max_calls=5)
    await wf_client.post(f"/api/workflows/{plan['id']}/approve", json={})
    done = await wait_for(wf_client, plan["id"], "completed", "partial", "failed")
    assert done["status"] == "failed"
    assert "safety limit of 5 model requests" in done["status_reason"]
    assert done["calls_used"] == 5
    assert len(agents.calls) == 5


async def test_restart_pauses_and_resume_finishes(
    wf_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    app = wf_client.app  # type: ignore[attr-defined]
    plan = await start(wf_client)
    agents.delay = 0.3
    await wf_client.post(f"/api/workflows/{plan['id']}/approve", json={})
    await asyncio.sleep(0.1)
    app.state.workflows._stop_steps(plan["id"])  # simulate the process stopping mid-step
    await asyncio.sleep(0.05)
    await app.state.workflows.recover()
    paused = (await wf_client.get(f"/api/workflows/{plan['id']}")).json()
    assert paused["status"] == "paused"
    assert "server restarted" in paused["status_reason"]
    assert by_department(paused, "work")["research"]["status"] == "queued"
    agents.delay = 0
    await wf_client.post(f"/api/workflows/{plan['id']}/resume")
    done = await wait_for(wf_client, plan["id"], "completed", "partial", "failed")
    assert done["status"] == "completed"


async def test_live_statuses_follow_the_work(
    wf_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    app = wf_client.app  # type: ignore[attr-defined]
    seen: set[tuple[str, str]] = set()
    async with app.state.events.subscribe() as sub:
        plan = await start(wf_client)
        await wf_client.post(f"/api/workflows/{plan['id']}/approve", json={})
        await wait_for(wf_client, plan["id"], "completed", "partial", "failed")
        while not sub.queue.empty():
            event = sub.queue.get_nowait()
            if event and event.type == "employee.updated":
                seen.add((event.data["status"], event.data["status_detail"] or ""))
    statuses = {s for s, _ in seen}
    assert {"working", "reviewing", "completed"} <= statuses
    assert any(d.startswith("Planning: ") for s, d in seen if s == "working")
    assert any(d.startswith("Reviewing: ") for s, d in seen if s == "reviewing")


# ------------------------------------------------------------ chat & tasks


async def test_delegating_from_chat_posts_notices_and_the_ceos_report(
    wf_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    roster = (await wf_client.get("/api/employees")).json()
    ceo = next(e for e in roster if e["role"] == "Chief Executive Officer")
    cid = (
        await wf_client.post(
            "/api/conversations", json={"kind": "employee", "employee_id": ceo["id"]}
        )
    ).json()["id"]
    sent = await wf_client.post(f"/api/conversations/{cid}/messages", data={"content": OBJECTIVE})
    message_id = sent.json()["message"]["id"]
    reply = wf_client.app.state.chat.replies.get(cid)  # type: ignore[attr-defined]
    if reply and reply.task:
        await reply.task
    r = await wf_client.post("/api/workflows", json={"source_message_id": message_id})
    assert r.status_code == 201
    wid = r.json()["id"]
    assert r.json()["objective"] == OBJECTIVE
    await wait_for(wf_client, wid, "awaiting_approval")
    await wf_client.post(f"/api/workflows/{wid}/approve", json={})
    await wait_for(wf_client, wid, "completed")
    history = (await wf_client.get(f"/api/conversations/{cid}/messages")).json()
    notices = [m["content"] for m in history if m["role"] == "system"]
    assert any(n.startswith("Workflow started") for n in notices)
    assert any("plan is ready" in n for n in notices)
    report = history[-1]
    assert report["role"] == "agent" and report["employee_id"] == ceo["id"]
    assert report["content"].startswith("**Final report")
    # Notices are not fed to the model as conversation.
    await wf_client.post(f"/api/conversations/{cid}/messages", data={"content": "Thanks!"})
    reply = wf_client.app.state.chat.replies.get(cid)  # type: ignore[attr-defined]
    if reply and reply.task:
        await reply.task
    chat_prompt = [p for f, p in agents.calls if f == "CHAT"][-1]
    assert "Workflow started" not in chat_prompt


async def test_recorded_task_can_be_handed_to_the_ceo(wf_client: httpx.AsyncClient) -> None:
    task = (
        await wf_client.post(
            "/api/tasks",
            json={
                "title": "Plan a launch",
                "description": "Plan the product launch for next month.",
                "department": "marketing",
            },
        )
    ).json()
    r = await wf_client.post("/api/workflows", json={"source_task_id": task["id"]})
    assert r.status_code == 201
    wid = r.json()["id"]
    assert "Plan the product launch" in r.json()["objective"]
    await wait_for(wf_client, wid, "awaiting_approval")
    await wf_client.post(f"/api/workflows/{wid}/approve", json={})
    await wait_for(wf_client, wid, "completed")
    tasks = (await wf_client.get("/api/tasks?department=marketing&kind=manual")).json()
    assert tasks[0]["status"] == "done"
    work = (await wf_client.get(f"/api/tasks?workflow_id={wid}&kind=work")).json()
    assert work
    assert (
        await wf_client.patch(f"/api/tasks/{work[0]['id']}", json={"status": "cancelled"})
    ).status_code == 409


async def test_validation(wf_client: httpx.AsyncClient) -> None:
    assert (
        await wf_client.post("/api/workflows", json={"objective": "too short"})
    ).status_code == 422
    assert (await wf_client.get("/api/workflows/wf_missing")).status_code == 404
    assert (
        await wf_client.post("/api/workflows", json={"source_message_id": 999})
    ).status_code == 404
    roster = (await wf_client.get("/api/employees")).json()
    ceo = next(e for e in roster if e["role"] == "Chief Executive Officer")
    await wf_client.post(f"/api/employees/{ceo['id']}/suspend")
    r = await wf_client.post("/api/workflows", json={"objective": OBJECTIVE})
    assert r.status_code == 409
    assert "CEO is unavailable" in r.json()["detail"]


async def test_list_and_counts(wf_client: httpx.AsyncClient) -> None:
    plan = await start(wf_client)
    listed = (await wf_client.get("/api/workflows")).json()
    assert listed[0]["id"] == plan["id"]
    assert listed[0]["assignments"]["total"] == 2
    async with wf_client.app.state.db.sessionmaker() as session:  # type: ignore[attr-defined]
        assert (await session.get(Workflow, plan["id"])).calls_used == 1  # type: ignore[union-attr]
        assert (
            len(list(await session.scalars(select(Task).where(Task.workflow_id == plan["id"]))))
            == 2
        )


# ------------------------------------------------------------- plan checks


def test_plan_validation_rules() -> None:
    available = {"research": "Research", "engineering": "Engineering", "finance": "Finance"}

    def plan(*assignments: dict[str, Any]) -> str:
        return (
            "Here you go:\n```json\n"
            + json.dumps({"summary": "A plan.", "assignments": list(assignments)})
            + "\n```"
        )

    def a(id: str, dept: str, deps: list[str] | None = None) -> dict[str, Any]:
        return {
            "id": id,
            "department": dept,
            "title": "Do it",
            "instructions": "Do the thing well.",
            "depends_on": deps or [],
        }

    ok = plans.parse_plan(plan(a("a1", "research"), a("a2", "engineering", ["a1"])), available)
    assert [x.id for x in ok.assignments] == ["a1", "a2"]
    for bad, message in [
        (plan(a("a1", "research", ["a2"]), a("a2", "engineering", ["a1"])), "cycle"),
        (plan(a("a1", "research"), a("a1", "engineering")), "unique"),
        (plan(a("a1", "research"), a("a2", "research")), "appears twice"),
        (plan(a("a1", "research", ["zz"])), "unknown assignment"),
        (plan(a("a1", "research", ["a1"])), "depends on itself"),
        (plan(a("a1", "marketing")), "Unknown or unavailable department"),
        (
            plan(
                *[
                    a(f"a{i}", k)
                    for i, k in enumerate(["research", "engineering", "finance", "x", "y"])
                ]
            ),
            "limit is 4",
        ),
        ("no json here", "did not contain a JSON object"),
    ]:
        with pytest.raises(plans.PlanError, match=message):
            plans.parse_plan(bad, available)


def test_format_echo_is_removed_from_deliverables() -> None:
    from app.orchestration.prompts import clean_text

    assert clean_text("NEXUS-REPORT/1\n\n# Summary\nText") == "# Summary\nText"
    assert clean_text("Format: NEXUS-WORK/1\nBody") == "Body"
    assert (
        clean_text("# Summary mentions NEXUS-REPORT/1 inline")
        == "# Summary mentions NEXUS-REPORT/1 inline"
    )


def test_breakdown_and_review_parsing() -> None:
    team = {"iris wong": "e1", "amara mensah": "e2"}
    text = json.dumps(
        {
            "approach": "Split.",
            "tasks": [{"title": "API", "instructions": "Design the API.", "assignee": "Amara"}],
        }
    )
    _, assignees = plans.parse_breakdown(text, team)
    assert assignees == ["e2"]
    with pytest.raises(plans.PlanError, match="isn't on the team"):
        plans.parse_breakdown(text.replace("Amara", "Nobody Known"), team)
    many = json.dumps(
        {"tasks": [{"title": "Task", "instructions": "Do something.", "assignee": "Iris Wong"}] * 3}
    )
    with pytest.raises(plans.PlanError, match="limit is 2"):
        plans.parse_breakdown(many, team)
    assert plans.parse_review('{"decision": "Approve", "feedback": "ok"}').decision == "approve"
    with pytest.raises(plans.PlanError):
        plans.parse_review('{"decision": "maybe"}')
    assert plans.topological_order({"a": ["b"], "b": []}) == ["b", "a"]
