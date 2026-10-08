"""Employee code runs in the sandbox only after the owner approves that exact code."""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from sqlalchemy import select

from app.ai.gateway import system_prompt
from app.main import create_app
from app.models import Conversation, Employee, Message
from app.sandbox import runner
from app.sandbox.service import sha256

pytestmark = pytest.mark.skipif(
    not runner.capabilities().available, reason="bubblewrap/systemd-run not available"
)

PROGRAM = """import csv, os, urllib.request
with open("report.csv", "w") as f:
    f.write("service,error_rate\\napi,2.5\\n")
print("rows written")
print("env:", sorted(os.environ))
print("home:", os.listdir(os.path.expanduser("~")))
try:
    urllib.request.urlopen("https://example.com", timeout=3)
    print("NETWORK OPEN")
except Exception as e:
    print("no network:", type(e).__name__)
"""


@pytest.fixture
async def http(
    migrated_db_url: str, make_settings: Any, tmp_path: Any
) -> AsyncIterator[httpx.AsyncClient]:
    settings = make_settings(
        NEXUS_DATABASE_URL=migrated_db_url, NEXUS_RUNS_DIR=str(tmp_path / "runs")
    )
    app = create_app(settings)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client,
    ):
        client.app = app  # type: ignore[attr-defined]
        yield client


async def agent_message(client: httpx.AsyncClient, content: str, role: str = "agent") -> int:
    app = client.app  # type: ignore[attr-defined]
    async with app.state.db.sessionmaker() as session:
        sameer = await session.scalar(select(Employee).where(Employee.department == "engineering"))
        conversation = Conversation(
            id="cnv_run",
            kind="employee",
            employee_id=sameer.id,
            department="engineering",
            title="Code",
        )
        if not await session.get(Conversation, "cnv_run"):
            session.add(conversation)
        message = Message(
            conversation_id="cnv_run",
            role=role,
            employee_id=sameer.id if role == "agent" else None,
            author_name=sameer.name if role == "agent" else None,
            content=content,
            status="complete",
        )
        session.add(message)
        await session.commit()
        return message.id


async def wait_run(client: httpx.AsyncClient, run_id: str, *statuses: str) -> dict[str, Any]:
    deadline = time.monotonic() + 40
    while True:
        run = (await client.get(f"/api/runs/{run_id}")).json()
        if run["status"] in statuses:
            return run
        if time.monotonic() > deadline:
            raise AssertionError(f"run stuck in {run['status']}")
        await asyncio.sleep(0.05)


async def test_code_runs_only_after_approval_isolated_from_the_computer(
    http: httpx.AsyncClient,
) -> None:
    caps = (await http.get("/api/runs/capabilities")).json()
    assert caps["available"] and "python" in caps["languages"]
    assert caps["limits"]["network"] is False
    mid = await agent_message(http, f"Here is the script:\n\n```python\n{PROGRAM}```\n")
    r = await http.post(
        "/api/runs", json={"code": PROGRAM, "language": "python", "message_id": mid}
    )
    assert r.status_code == 201, r.text
    run = r.json()
    assert run["status"] == "pending_approval" and run["stdout"] == ""
    await asyncio.sleep(0.3)
    assert (await http.get(f"/api/runs/{run['id']}")).json()["status"] == "pending_approval"

    wrong = await http.post(f"/api/runs/{run['id']}/approve", json={"code_sha256": "0" * 64})
    assert wrong.status_code == 409
    ok = await http.post(f"/api/runs/{run['id']}/approve", json={"code_sha256": sha256(PROGRAM)})
    assert ok.status_code == 200 and ok.json()["status"] == "running"
    again = await http.post(f"/api/runs/{run['id']}/approve", json={"code_sha256": sha256(PROGRAM)})
    assert again.status_code == 409

    done = await wait_run(http, run["id"], "succeeded", "failed", "error")
    assert done["status"] == "succeeded", done
    assert done["exit_code"] == 0
    assert "rows written" in done["stdout"]
    assert "no network: URLError" in done["stdout"]
    assert "NVIDIA" not in done["stdout"] and "NEXUS" not in done["stdout"]  # empty environment
    assert "home: ['main.py', 'report.csv']" in done["stdout"]  # only its own folder
    assert done["files"] == [{"name": "report.csv", "size": 27}]
    file = await http.get(f"/api/runs/{run['id']}/files/report.csv")
    assert file.status_code == 200 and file.text.startswith("service,error_rate")
    assert file.headers["content-disposition"].startswith("attachment")
    assert file.headers["x-content-type-options"] == "nosniff"
    assert (await http.get(f"/api/runs/{run['id']}/files/..%2Fwork")).status_code == 404


async def test_only_an_employees_own_code_can_be_run(http: httpx.AsyncClient) -> None:
    mid = await agent_message(http, "```python\nprint('hi')\n```")
    other = await http.post(
        "/api/runs",
        json={"code": "import os; os.system('rm -rf ~')", "language": "python", "message_id": mid},
    )
    assert other.status_code == 422  # not what the employee wrote
    owner = await agent_message(http, "```python\nprint('hi')\n```", role="owner")
    mine = await http.post(
        "/api/runs", json={"code": "print('hi')", "language": "python", "message_id": owner}
    )
    assert mine.status_code == 404
    lang = await http.post(
        "/api/runs", json={"code": "print('hi')", "language": "rust", "message_id": mid}
    )
    assert lang.status_code == 422


async def test_errors_timeouts_and_rejection_are_reported(
    http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(runner, "TIMEOUT_S", 2)
    code = "raise SystemExit('bad input')"
    loop = "while True:\n    pass"
    mid = await agent_message(
        http, f"```python\n{code}\n```\n```python\n{loop}\n```\n```bash\necho hi\n```"
    )
    failed = (
        await http.post("/api/runs", json={"code": code, "language": "py", "message_id": mid})
    ).json()
    await http.post(f"/api/runs/{failed['id']}/approve", json={"code_sha256": sha256(code)})
    result = await wait_run(http, failed["id"], "failed")
    assert result["exit_code"] == 1 and "bad input" in result["stderr"]
    slow = (
        await http.post("/api/runs", json={"code": loop, "language": "python", "message_id": mid})
    ).json()
    await http.post(f"/api/runs/{slow['id']}/approve", json={"code_sha256": sha256(loop)})
    timed = await wait_run(http, slow["id"], "timed_out")
    assert timed["error"] == "Stopped after 2 seconds."
    no = (
        await http.post(
            "/api/runs", json={"code": "echo hi", "language": "bash", "message_id": mid}
        )
    ).json()
    assert (await http.post(f"/api/runs/{no['id']}/reject")).json()["status"] == "rejected"
    late = await http.post(f"/api/runs/{no['id']}/approve", json={"code_sha256": sha256("echo hi")})
    assert late.status_code == 409


def test_code_writing_departments_know_the_sandbox() -> None:
    from types import SimpleNamespace

    dept = SimpleNamespace(name="X", description="x", responsibilities=["x"])
    engineer = SimpleNamespace(name="A", role="Dev", department="engineering", gender=None)
    seller = SimpleNamespace(name="B", role="AE", department="sales", gender=None)
    assert "NEXUS's sandbox" in system_prompt(engineer, dept)  # type: ignore[arg-type]
    assert "NEXUS's sandbox" not in system_prompt(seller, dept)  # type: ignore[arg-type]
