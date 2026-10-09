"""Tasks the owner creates are done by the employee, like in a real company."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from tests import test_workflows
from tests.test_chat import employee_by_name, open_chat, send, settle
from tests.test_workflows import AgentProvider

# The workflow tests' app: the fake provider answers each prompt in its format.
agents = test_workflows.agents
wf_client = test_workflows.wf_client


async def wait_task(client: httpx.AsyncClient, task_id: str, *statuses: str) -> dict[str, Any]:
    deadline = time.monotonic() + 10
    while True:
        tasks = (await client.get("/api/tasks")).json()
        task = next(t for t in tasks if t["id"] == task_id)
        if task["status"] in statuses:
            return task
        if time.monotonic() > deadline:
            raise AssertionError(f"task stuck in {task['status']}: {task.get('error')}")
        await asyncio.sleep(0.02)


async def wait_task_artifact(client: httpx.AsyncClient, task_id: str) -> dict[str, Any]:
    deadline = time.monotonic() + 10
    while True:
        search = await client.get(
            "/api/storage/search",
            params={
                "workspace_id": "ws_department:marketing",
                "tag": "ai-generated",
                "kind": "file",
            },
        )
        for entry in search.json()["items"]:
            detail = (await client.get(f"/api/storage/entries/{entry['id']}")).json()
            if any(
                link["target_type"] == "task" and link["target_id"] == task_id
                for link in detail["links"]
            ):
                return detail
        if time.monotonic() > deadline:
            raise AssertionError("completed task was not registered in the Vault")
        await asyncio.sleep(0.02)


async def test_a_task_from_chat_is_done_and_reported_in_the_chat(
    wf_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    cid = await open_chat(wf_client, department="marketing")
    r = await send(wf_client, cid, "We need a launch plan for the new app.")
    message_id = r.json()["message"]["id"]
    await settle(wf_client, cid)
    created = await wf_client.post(
        "/api/tasks",
        json={
            "title": "Write the launch plan",
            "description": "Three steps for the launch of the new app.",
            "department": "marketing",
            "source_conversation_id": cid,
            "source_message_id": message_id,
        },
    )
    assert created.status_code == 201, created.text
    task = created.json()
    assert task["status"] == "running"
    elena = await employee_by_name(wf_client, "Elena Rossi")
    assert task["assignee_id"] == elena["id"]  # nobody chosen: the director takes it
    done = await wait_task(wf_client, task["id"], "done", "failed")
    assert done["status"] == "done", done["error"]
    assert "three concrete steps" in done["result"]
    assert done["calls"] == 1 and done["attempts"] == 1
    prompt = next(p for f, p in agents.calls if f == "TASK")
    assert "Task: Write the launch plan" in prompt
    assert "We need a launch plan for the new app." in prompt  # the chat as context
    messages = (await wf_client.get(f"/api/conversations/{cid}/messages")).json()
    report = messages[-1]
    assert report["role"] == "agent" and report["author_name"] == "Elena Rossi"
    assert report["content"].startswith("✅ **Task done: Write the launch plan**")
    artifact = await wait_task_artifact(wf_client, task["id"])
    assert artifact["artifact_type"] == "task-result"
    assert artifact["created_by_name"] == "Elena Rossi"
    stored = await wf_client.get(f"/api/storage/entries/{artifact['id']}/download")
    assert stored.text == done["result"]


async def test_a_failed_task_says_why_and_can_run_again(
    wf_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    priya = await employee_by_name(wf_client, "Priya Nair")
    agents.on("TASK", 500, 500, 500)
    created = await wf_client.post(
        "/api/tasks",
        json={"title": "Prospect list", "department": "sales", "assignee_id": priya["id"]},
    )
    failed = await wait_task(wf_client, created.json()["id"], "failed")
    assert failed["error"]
    rerun = await wf_client.post(f"/api/tasks/{failed['id']}/run")
    assert rerun.status_code == 200 and rerun.json()["status"] == "running"
    done = await wait_task(wf_client, failed["id"], "done")
    assert done["attempts"] == 2 and done["assignee_id"] == priya["id"]
    again = await wf_client.post(f"/api/tasks/{failed['id']}/run")
    assert again.status_code == 409  # already done


async def test_a_running_task_can_be_cancelled(
    wf_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    agents.on("TASK", ("slow", 5))
    created = await wf_client.post(
        "/api/tasks", json={"title": "Long analysis", "department": "finance"}
    )
    task = created.json()
    assert task["status"] == "running"
    r = await wf_client.patch(f"/api/tasks/{task['id']}", json={"status": "cancelled"})
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    await asyncio.sleep(0.1)
    final = await wait_task(wf_client, task["id"], "cancelled")
    assert final["result"] is None


async def test_record_only_tasks_stay_open(wf_client: httpx.AsyncClient) -> None:
    created = await wf_client.post(
        "/api/tasks", json={"title": "For the CEO later", "department": "sales", "run": False}
    )
    assert created.json()["status"] == "open"
    started = await wf_client.post(f"/api/tasks/{created.json()['id']}/run")
    assert started.json()["status"] == "running"
    await wait_task(wf_client, created.json()["id"], "done")
