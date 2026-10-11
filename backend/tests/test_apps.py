"""Apps: design, approval, role-based writing, checks, review, fixes, limits, versions,
storage and download. Running apps in the sandbox is in test_app_runtime.py."""

from __future__ import annotations

import asyncio
import io
import json
import zipfile
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import select

from app.apps import checks, plans
from app.apps.files import write_tree
from app.apps.stacks import MAX_FILES, STACKS, area_of, clean_path, dependencies, tree_sha256
from app.main import create_app
from app.models import AppVersion, Employee
from app.orchestration.plans import PlanError
from tests.fake_agents import APP_FILES
from tests.test_ai import FAKE_KEY, MASTER, _no_sleep, ready_catalog
from tests.test_workflows import AgentProvider

REQUEST = "Build a small web app where my team can keep a shared list of notes."
DESIGN_FILES = ["server.py", "static/index.html", "static/app.js", "README.md"]


@pytest.fixture
def agents() -> AgentProvider:
    return AgentProvider()


@pytest.fixture
async def apps_client(
    migrated_db_url: str, make_settings: Any, agents: AgentProvider, tmp_path: Path
) -> AsyncIterator[httpx.AsyncClient]:
    settings = make_settings(
        NEXUS_DATABASE_URL=migrated_db_url,
        NVIDIA_API_KEY=FAKE_KEY,
        NEXUS_SECRET_KEY=MASTER,
        NEXUS_APPS_DIR=str(tmp_path / "apps"),
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
            await app.state.apps.shutdown()


async def wait_for(
    client: httpx.AsyncClient, app_id: str, *statuses: str, within: float = 30
) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + within
    while True:
        data = (await client.get(f"/api/apps/{app_id}")).json()
        if data["status"] in statuses:
            return data
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(f"app stuck in {data['status']}: {data.get('status_reason')}")
        await asyncio.sleep(0.02)


async def design(client: httpx.AsyncClient, **extra: Any) -> dict[str, Any]:
    r = await client.post("/api/apps", json={"description": REQUEST, **extra})
    assert r.status_code == 201, r.text
    return await wait_for(client, r.json()["id"], "awaiting_approval", "failed")


async def build(client: httpx.AsyncClient, **extra: Any) -> dict[str, Any]:
    app = await design(client, **extra)
    assert app["status"] == "awaiting_approval", app["status_reason"]
    assert (await client.post(f"/api/apps/{app['id']}/approve")).status_code == 200
    return await wait_for(client, app["id"], "ready", "failed", "paused")


def files(app: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {f["path"]: f for f in app["current"]["files"]}


def kinds(app: dict[str, Any]) -> list[str]:
    return [e["kind"] for e in app["events"]]


def written_paths(agents: AgentProvider) -> list[str]:
    return [
        prompt.split("Your file: `", 1)[1].split("`", 1)[0]
        for fmt, prompt in agents.calls
        if fmt == "APPFILE"
    ]


def no_sandbox(
    monkeypatch: pytest.MonkeyPatch, client: httpx.AsyncClient, fails: dict[str, list[str]]
) -> None:
    """Replaces the syntax checker: `fails[path]` holds the errors of successive checks."""

    async def check(tree: dict[str, str], stack: Any, scratch: Path) -> checks.Report:
        report = checks.Report(sandboxed=True)
        for path in tree:
            errors = fails.get(path, [])
            error = errors.pop(0) if errors else None
            report.files[path] = (checks.FAILED, error) if error else (checks.OK, None)
        return report

    monkeypatch.setattr(client.app.state.apps, "check", check)  # type: ignore[attr-defined]


# ------------------------------------------------------------ design and roles


async def test_the_architect_designs_and_files_go_to_the_matching_roles(
    apps_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    app = await design(apps_client)
    assert app["status"] == "awaiting_approval"
    assert app["name"] == "Team Notes"  # the name comes from the validated design
    assert app["current"]["architect"]["role"] == "Software Architect"
    assert app["current"]["stack"] == "python"
    assert [c[0] for c in agents.calls] == ["APPPLAN"]  # nothing else ran yet

    planned = files(app)
    # Writing order: backend, frontend, then docs; the README is added by code.
    assert list(planned) == DESIGN_FILES
    assert {p: f["area"] for p, f in planned.items()} == {
        "server.py": "backend",
        "static/index.html": "frontend",
        "static/app.js": "frontend",
        "README.md": "docs",
    }
    assert planned["server.py"]["author_role"] == "Backend Developer"
    assert planned["static/index.html"]["author_role"] == "Frontend Developer"
    assert planned["static/app.js"]["author_role"] == "Frontend Developer"
    assert planned["README.md"]["author_role"] == "Software Architect"
    assert all(f["status"] == "planned" and f["size"] == 0 for f in planned.values())
    assert app["current"]["estimate"]["typical"] == 6  # 4 files + review + delivery note
    assert kinds(app) == ["created", "designed"]

    await asyncio.sleep(0.2)  # nothing is written without approval
    assert [c[0] for c in agents.calls] == ["APPPLAN"]
    assert (await apps_client.get(f"/api/apps/{app['id']}")).json()["status"] == "awaiting_approval"


async def test_roles_fall_back_when_nobody_with_the_role_is_available(
    apps_client: httpx.AsyncClient,
) -> None:
    async with apps_client.app.state.db.sessionmaker() as session:  # type: ignore[attr-defined]
        team = list(
            await session.scalars(select(Employee).where(Employee.department == "engineering"))
        )
        by_role = {e.role: e for e in team}
    for role in ("Backend Developer", "Frontend Developer", "Software Architect"):
        r = await apps_client.post(f"/api/employees/{by_role[role].id}/suspend")
        assert r.status_code == 200, r.text
    app = await design(apps_client)
    planned = files(app)
    cto = by_role["Chief Technology Officer"]
    assert app["current"]["architect"]["id"] == cto.id  # no architect: the lead designs
    assert planned["server.py"]["author_role"] == "AI Engineer"  # next in line for backend
    assert planned["static/app.js"]["employee_id"] == cto.id  # nobody for frontend: the lead
    assert planned["README.md"]["employee_id"] == cto.id

    for employee in team:
        await apps_client.post(f"/api/employees/{employee.id}/suspend")
    r = await apps_client.post("/api/apps", json={"description": REQUEST})
    assert r.status_code == 409 and "Nobody in Software Engineering" in r.json()["detail"]


async def test_unusable_designs_are_retried_once_then_fail(
    apps_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    def bad(**change: Any) -> str:
        base = {
            "name": "Notes",
            "summary": "A small notes app for the team.",
            "stack": "python",
            "files": [
                {"path": "server.py", "purpose": "The server."},
                {"path": "static/index.html", "purpose": "The page."},
            ],
        }
        return json.dumps({**base, **change})

    agents.on("APPPLAN", bad(stack="rust"))
    app = await design(apps_client)
    assert app["status"] == "awaiting_approval"  # the second reply was valid
    assert agents.count("APPPLAN") == 2
    assert "Unknown stack 'rust'" in agents.calls[1][1]  # the error was fed back
    assert "retry" in kinds(app)

    agents.on(
        "APPPLAN",
        bad(files=[{"path": "../../etc/cron.d/job.py", "purpose": "escape"}]),
        bad(files=[{"path": "server.py", "purpose": "No page at all."}]),
    )
    failed = await design(apps_client)
    assert failed["status"] == "failed"
    assert "static/index.html" in failed["status_reason"]  # a required file is missing
    assert failed["current"]["files"] == []


def test_design_validation_is_code_not_prompt() -> None:
    def parse(**change: Any) -> plans.Design:
        base: dict[str, Any] = {
            "name": "Notes",
            "summary": "A small notes app for the team.",
            "stack": "node",
            "files": [
                {"path": "server.js", "purpose": "The server."},
                {"path": "package.json", "purpose": "Packages."},
                {"path": "public/index.html", "purpose": "The page."},
            ],
        }
        return plans.parse_design(json.dumps({**base, **change}))

    ok = parse(api=[{"GET /api/x": "list"}], packages=["express", 5, "bad name!"])
    assert [f.path for f in ok.files][-1] == "README.md"  # always added
    assert ok.packages == ["express", "5"] and ok.api.startswith("[")  # coerced to text

    for path in (
        "/etc/passwd.txt", "..\\x.py", "a/../b.py", ".env", "src/.hidden/x.py",
        "node_modules/x/index.js", "data/db.json", "run.sh", "a b.py", "x" * 130 + ".py",
        "a/b/c/d/e/f.py",
    ):  # fmt: skip
        with pytest.raises(ValueError):
            clean_path(path)
    assert clean_path(".\\static\\app.js") == "static/app.js"

    with pytest.raises(PlanError, match="twice"):
        parse(
            files=[{"path": "server.js", "purpose": "one"}, {"path": "Server.js", "purpose": "two"}]
        )
    many = [{"path": f"public/p{i}.html", "purpose": "page"} for i in range(MAX_FILES)]
    with pytest.raises(PlanError, match="limit"):
        parse(files=[*many, *[{"path": p, "purpose": "x x"} for p in STACKS["node"].required]])

    react = STACKS["python-react"]
    assert area_of(react, "frontend/package.json") == "setup"
    assert area_of(react, "frontend/vite.config.js") == "setup"
    assert area_of(react, "frontend/src/App.jsx") == "frontend"
    assert area_of(react, "db.py") == "backend" and area_of(react, "README.md") == "docs"


def test_file_replies_are_unwrapped_and_cut_off_replies_refused() -> None:
    assert plans.extract_file("```python\nprint(1)\n```", "a.py") == "print(1)\n"
    assert plans.extract_file('```json\n{"a": 1}```', "a.json") == '{"a": 1}\n'
    assert (
        plans.extract_file("Format: NEXUS-APPFILE/1\nHere:\n```js\nlet a;\n```\nDone.", "a.js")
        == "let a;\n"
    )
    assert plans.extract_file("x = 1", "a.py") == "x = 1\n"
    readme = "```markdown\n# T\n\n```bash\nrun\n```\n\nend\n```"
    assert plans.extract_file(readme, "README.md") == "# T\n\n```bash\nrun\n```\n\nend\n"
    for cut in ("```python\nprint(1", "```python"):
        with pytest.raises(PlanError, match="cut off"):
            plans.extract_file(cut, "a.py")
    with pytest.raises(PlanError, match="cut off"):
        plans.extract_file("x = 1", "a.py", "length")
    with pytest.raises(PlanError, match="no file content"):
        plans.extract_file("```python\n\n```", "a.py")


# ------------------------------------------------------------------- building


async def test_approved_design_is_written_checked_reviewed_and_delivered(
    apps_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    app = await build(apps_client)
    assert app["status"] == "ready", app["status_reason"]
    assert [c[0] for c in agents.calls] == ["APPPLAN", *["APPFILE"] * 4, "APPREVIEW", "APPDELIVERY"]
    assert app["calls_used"] == 7 and app["prompt_tokens"] == 700
    assert written_paths(agents) == DESIGN_FILES

    # The frontend developer is given the backend that was just written.
    frontend_prompt = next(
        p for f, p in agents.calls if f == "APPFILE" and "Your file: `static/app.js`" in p
    )
    assert (
        "<<<FILE server.py (by Yusuf Demir)" in frontend_prompt
        and "ThreadingHTTPServer" in frontend_prompt
    )

    written = files(app)
    assert all(f["status"] == "written" and f["lines"] > 3 for f in written.values())
    assert written["server.py"]["check"] in ("ok", "skipped")  # ok wherever the sandbox exists
    assert written["README.md"]["check"] == "skipped"  # prose isn't syntax-checked
    assert app["current"]["summary"].startswith("## Delivered")
    assert app["current"]["known_issues"] == []
    assert kinds(app) == [
        "created", "designed", "approved", "written", "written", "written", "written",
        "checked", "reviewed", "ready",
    ]  # fmt: skip
    assert "Yusuf Demir (Backend Developer) wrote server.py" in " ".join(
        e["text"] for e in app["events"]
    )

    content = {path: body for path, (_, body) in APP_FILES.items() if path in DESIGN_FILES}
    assert app["current"]["tree_sha256"] == tree_sha256(content)

    base = f"/api/apps/{app['id']}/versions/1"
    server = (await apps_client.get(f"{base}/file", params={"path": "server.py"})).json()
    assert server["content"] == content["server.py"] and server["author_name"] == "Yusuf Demir"
    for missing in ("../server.py", "nope.py", "/etc/passwd"):
        assert (await apps_client.get(f"{base}/file", params={"path": missing})).status_code == 404

    archive = await apps_client.get(f"{base}/download")
    assert archive.headers["content-type"] == "application/zip"
    assert archive.headers["content-disposition"] == 'attachment; filename="team-notes-v1.zip"'
    assert archive.headers["x-content-type-options"] == "nosniff"
    with zipfile.ZipFile(io.BytesIO(archive.content)) as zipped:
        assert sorted(zipped.namelist()) == sorted(f"team-notes-v1/{p}" for p in DESIGN_FILES)
        assert zipped.read("team-notes-v1/static/app.js").decode() == content["static/app.js"]
    assert (await apps_client.get(f"/api/apps/{app['id']}/versions/9/download")).status_code == 404

    listed = (await apps_client.get("/api/apps")).json()
    assert [(a["name"], a["status"], a["ready_version"]) for a in listed] == [
        ("Team Notes", "ready", 1)
    ]


async def test_only_one_approval_counts_and_only_while_waiting(
    apps_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    app = await design(apps_client)
    agents.delay = 0.05
    replies = await asyncio.gather(
        *(apps_client.post(f"/api/apps/{app['id']}/approve") for _ in range(4))
    )
    assert sorted(r.status_code for r in replies) == [200, 409, 409, 409]
    done = await wait_for(apps_client, app["id"], "ready", "failed")
    assert done["status"] == "ready" and agents.count("APPFILE") == 4  # written once
    assert kinds(done).count("approved") == 1
    assert (await apps_client.post(f"/api/apps/{app['id']}/approve")).status_code == 409
    assert (await apps_client.post("/api/apps/app_missing/approve")).status_code == 404


async def test_a_file_that_cannot_be_written_fails_the_build_and_resume_retries_it(
    apps_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    agents.on("APPFILE", "```python\nprint('cut", "empty")  # server.py: cut off, then nothing
    app = await build(apps_client)
    assert app["status"] == "failed"
    assert "server.py" in app["status_reason"] and "Resume" in app["status_reason"]
    state = files(app)
    assert state["server.py"]["status"] == "failed" and state["server.py"]["attempts"] == 2
    assert state["static/app.js"]["status"] == "planned"  # stopped: nothing else was spent
    assert agents.count("APPFILE") == 2
    assert "written in one code block" not in agents.calls[1][1]
    assert "cut off before the file ended" in agents.calls[2][1]  # fed back on the retry
    assert app["current"]["known_issues"][0].startswith("server.py: could not be written")
    assert (await apps_client.get(f"/api/apps/{app['id']}/versions/1/download")).status_code == 409

    assert (await apps_client.post(f"/api/apps/{app['id']}/resume")).status_code == 200
    done = await wait_for(apps_client, app["id"], "ready", "failed")
    assert done["status"] == "ready"
    assert agents.count("APPFILE") == 6 and all(
        f["status"] == "written" for f in files(done).values()
    )
    assert (await apps_client.post(f"/api/apps/{app['id']}/resume")).status_code == 409


async def test_problems_from_checks_and_review_are_fixed_once_and_the_rest_is_listed(
    apps_client: httpx.AsyncClient, agents: AgentProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    no_sandbox(
        monkeypatch,
        apps_client,
        {
            "static/app.js": ["line 3: Unexpected token"],  # fixed by the rewrite
            "server.py": ["line 9: invalid syntax", "line 9: invalid syntax"],  # still broken
        },
    )
    agents.on(
        "APPREVIEW",
        json.dumps(
            {
                "decision": "revise",
                "issues": [
                    {
                        "path": "static/index.html",
                        "problem": "The form has no submit button label.",
                    },
                    {
                        "path": "STATIC/app.js",
                        "problem": "It posts to /api/note, which doesn't exist.",
                    },
                ],
            }
        ),
    )
    app = await build(apps_client)
    assert app["status"] == "ready"  # delivered, with what remains listed
    assert agents.count("APPREVIEW") == 1  # one review, no review loop
    assert agents.count("APPFILE") == 4 + 3  # each problem file is rewritten exactly once
    fixes = [p for f, p in agents.calls if f == "APPFILE" and "PROBLEMS TO FIX" in p]
    assert len(fixes) == 3
    app_js = next(p for p in fixes if "Your file: `static/app.js`" in p)
    assert "Automatic check: line 3: Unexpected token" in app_js
    assert "Review: It posts to /api/note" in app_js and "YOUR PREVIOUS VERSION" in app_js

    state = files(app)
    assert state["static/app.js"]["revisions"] == 1 and state["static/app.js"]["check"] == "ok"
    assert state["static/index.html"]["revisions"] == 1
    assert state["README.md"]["revisions"] == 0
    assert state["server.py"]["revisions"] == 1 and state["server.py"]["check"] == "failed"
    assert app["current"]["known_issues"] == ["server.py: line 9: invalid syntax"]
    assert app["status_reason"] == "1 known problem — see the files."
    assert "server.py: line 9: invalid syntax" in next(
        p for f, p in agents.calls if f == "APPDELIVERY"
    )
    assert kinds(app).count("fixed") == 3 and kinds(app).count("checked") == 2


async def test_a_review_that_cannot_be_used_is_reported_not_hidden(
    apps_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    unknown = json.dumps(
        {"decision": "revise", "issues": [{"path": "main.go", "problem": "Wrong language."}]}
    )
    agents.on("APPREVIEW", unknown, "invalid")
    app = await build(apps_client)
    assert app["status"] == "ready"
    assert "review_skipped" in kinds(app) and "reviewed" not in kinds(app)
    assert "without a review" in next(
        e["text"] for e in app["events"] if e["kind"] == "review_skipped"
    )
    assert "'main.go' isn't a file of this app" in agents.calls[-2][1]


# ------------------------------------------------------- limits and owner control


async def test_the_request_cap_stops_a_build(
    apps_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    issues = [{"path": p, "problem": "Rewrite this file."} for p in DESIGN_FILES]
    agents.on("APPREVIEW", json.dumps({"decision": "revise", "issues": issues}))
    app = await build(apps_client, max_calls=8)  # design + 4 files + review = 6; 4 fixes don't fit
    assert app["status"] == "failed"
    assert (
        app["status_reason"] == "Stopped at the safety limit of 8 model requests for one version."
    )
    assert app["calls_used"] == 8 and len(agents.calls) == 8
    r = await apps_client.post(f"/api/apps/{app['id']}/resume")
    assert r.status_code == 409 and "used all of its model requests" in r.json()["detail"]
    assert (
        await apps_client.post("/api/apps", json={"description": REQUEST, "max_calls": 3})
    ).status_code == 422


async def test_emergency_stop_pauses_and_resume_continues_where_it_stopped(
    apps_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    app = await design(apps_client)
    assert (await apps_client.patch("/api/ai/settings", json={"paused": True})).status_code == 200
    await apps_client.post(f"/api/apps/{app['id']}/approve")
    paused = await wait_for(apps_client, app["id"], "paused", "failed", "ready")
    assert paused["status"] == "paused" and "emergency stop" in paused["status_reason"]
    assert all(f["status"] == "planned" for f in files(paused).values())
    assert agents.count("APPFILE") == 0

    await apps_client.patch("/api/ai/settings", json={"paused": False})
    assert (await apps_client.post(f"/api/apps/{app['id']}/resume")).status_code == 200
    done = await wait_for(apps_client, app["id"], "ready", "failed")
    assert done["status"] == "ready" and agents.count("APPFILE") == 4
    assert kinds(done).count("paused") == 1 and "resumed" in kinds(done)


async def test_cancel_stops_work_in_flight(
    apps_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    app = await design(apps_client)
    agents.delay = 0.3
    await apps_client.post(f"/api/apps/{app['id']}/approve")
    await asyncio.sleep(0.45)  # the first file is done, the second is being written
    r = await apps_client.post(f"/api/apps/{app['id']}/cancel")
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    calls = len(agents.calls)
    state = files(r.json())
    assert state["server.py"]["status"] == "written"
    assert state["static/index.html"]["status"] == "planned"  # not left "writing"
    await asyncio.sleep(0.5)
    assert len(agents.calls) == calls  # nothing continued
    assert (await apps_client.post(f"/api/apps/{app['id']}/cancel")).status_code == 409
    assert (await apps_client.post(f"/api/apps/{app['id']}/resume")).status_code == 409


async def test_a_restart_pauses_builds_and_nothing_resumes_on_its_own(
    apps_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    app = await design(apps_client)
    builder = apps_client.app.state.apps  # type: ignore[attr-defined]
    async with apps_client.app.state.db.sessionmaker() as session:  # type: ignore[attr-defined]
        version = await session.scalar(select(AppVersion).where(AppVersion.app_id == app["id"]))
        version.status = "building"  # as if the server had stopped mid-build
        version.approved_at = version.created_at
        await session.commit()
    await builder.recover()
    paused = (await apps_client.get(f"/api/apps/{app['id']}")).json()
    assert paused["status"] == "paused" and "restarted" in paused["status_reason"]
    await asyncio.sleep(0.2)
    assert agents.count("APPFILE") == 0
    await apps_client.post(f"/api/apps/{app['id']}/resume")
    assert (await wait_for(apps_client, app["id"], "ready", "failed"))["status"] == "ready"


# ------------------------------------------------------------ change requests


async def test_a_change_request_rewrites_only_the_affected_files_in_a_new_version(
    apps_client: httpx.AsyncClient, agents: AgentProvider
) -> None:
    app = await build(apps_client)
    first_tree = app["current"]["tree_sha256"]
    before = len(agents.calls)
    r = await apps_client.post(
        f"/api/apps/{app['id']}/changes", json={"request": "Add an About page."}
    )
    assert r.status_code == 201, r.text
    planned = await wait_for(apps_client, app["id"], "awaiting_approval", "failed")
    assert planned["status"] == "awaiting_approval" and planned["version"] == 2
    assert planned["ready_version"] == 1  # version 1 stays usable meanwhile
    change_prompt = agents.calls[before][1]
    assert agents.calls[before][0] == "APPCHANGE" and "<<<FILE server.py" in change_prompt

    state = files(planned)
    assert {p: (f["action"], f["status"]) for p, f in state.items()} == {
        "server.py": ("keep", "written"),
        "static/index.html": ("modify", "planned"),
        "static/app.js": ("keep", "written"),
        "static/about.html": ("new", "planned"),
        "README.md": ("keep", "written"),
    }
    assert state["static/about.html"]["author_role"] == "Frontend Developer"
    assert planned["current"]["plan"]["change"]["summary"].startswith("Adds an About page")
    assert planned["current"]["estimate"]["typical"] == 4  # 2 files + review + delivery note
    again = await apps_client.post(
        f"/api/apps/{app['id']}/changes", json={"request": "And a footer."}
    )
    assert again.status_code == 409  # one build at a time

    await apps_client.post(f"/api/apps/{app['id']}/approve")
    done = await wait_for(apps_client, app["id"], "ready", "failed")
    assert done["status"] == "ready" and done["ready_version"] == 2
    assert written_paths(agents)[4:] == ["static/index.html", "static/about.html"]
    modify = next(p for f, p in agents.calls[before:] if f == "APPFILE" and "index.html`" in p)
    assert "CURRENT CONTENT OF static/index.html" in modify and "WHAT TO CHANGE" in modify
    review = next(p for f, p in agents.calls[before:] if f == "APPREVIEW")
    assert "changed only these files" in review and "`static/about.html`" in review

    base = f"/api/apps/{app['id']}/versions"
    new_index = (
        await apps_client.get(f"{base}/2/file", params={"path": "static/index.html"})
    ).json()
    old_index = (
        await apps_client.get(f"{base}/1/file", params={"path": "static/index.html"})
    ).json()
    assert "about.html" in new_index["content"] and "about.html" not in old_index["content"]
    assert (
        await apps_client.get(f"{base}/1/file", params={"path": "static/about.html"})
    ).status_code == 404
    assert [v["number"] for v in done["versions"]] == [1, 2]
    assert done["versions"][0]["tree_sha256"] == first_tree != done["current"]["tree_sha256"]
    old = (await apps_client.get(f"/api/apps/{app['id']}", params={"version": 1})).json()
    assert len(old["current"]["files"]) == 4 and old["current"]["number"] == 1
    with zipfile.ZipFile(
        io.BytesIO((await apps_client.get(f"{base}/2/download")).content)
    ) as zipped:
        assert len(zipped.namelist()) == 5


def test_change_plans_are_validated_in_code() -> None:
    stack = STACKS["python"]
    existing = {"server.py", "static/index.html", "static/app.js"}

    def parse(*changes: dict[str, str]) -> plans.Change:
        return plans.parse_change(
            json.dumps({"summary": "A change.", "files": list(changes)}), stack, existing
        )

    ok = parse({"path": "STATIC/app.js", "action": "Modify", "instructions": "Fix the URL."})
    assert ok.files[0].path == "static/app.js" and ok.files[0].action == "modify"
    for change, message in (
        ({"path": "server.py", "action": "delete"}, "required by the stack"),
        ({"path": "static/app.js", "action": "add", "instructions": "x"}, "already exists"),
        ({"path": "static/new.js", "action": "modify", "instructions": "x y z"}, "isn't a file"),
        ({"path": "../x.py", "action": "add", "instructions": "x y z"}, "File path"),
        ({"path": "static/app.js", "action": "modify"}, "Say what to do"),
    ):
        with pytest.raises(PlanError, match=message):
            parse(change)


# -------------------------------------------------------------------- storage


async def test_deleting_an_app_removes_everything(apps_client: httpx.AsyncClient) -> None:
    app = await build(apps_client)
    assert (await apps_client.delete(f"/api/apps/{app['id']}")).status_code == 204
    assert (await apps_client.get(f"/api/apps/{app['id']}")).status_code == 404
    assert (await apps_client.get("/api/apps")).json() == []
    async with apps_client.app.state.db.sessionmaker() as session:  # type: ignore[attr-defined]
        assert list(await session.scalars(select(AppVersion))) == []
    assert (await apps_client.delete(f"/api/apps/{app['id']}")).status_code == 404


async def test_deleting_an_app_waits_for_its_copy_to_the_vault(
    apps_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    registrar = apps_client.app.state.artifacts  # type: ignore[attr-defined]
    register = registrar.register_app_version
    started, release = asyncio.Event(), asyncio.Event()
    finished: list[str] = []

    async def held(version_id: str) -> Any:
        started.set()
        await release.wait()
        summary = await register(version_id)
        finished.append(version_id)
        return summary

    monkeypatch.setattr(registrar, "register_app_version", held)
    app = await design(apps_client)
    assert (await apps_client.post(f"/api/apps/{app['id']}/approve")).status_code == 200
    await asyncio.wait_for(started.wait(), 30)

    # Cancelling the copy in the middle of a write could leave the database locked.
    deleting = asyncio.create_task(apps_client.delete(f"/api/apps/{app['id']}"))
    await asyncio.sleep(0.1)
    assert not deleting.done()
    release.set()
    assert (await deleting).status_code == 204
    assert len(finished) == 1
    assert (await apps_client.get("/api/apps")).json() == []


async def test_build_from_a_chat_message_reports_back_in_that_conversation(
    apps_client: httpx.AsyncClient,
) -> None:
    async with apps_client.app.state.db.sessionmaker() as session:  # type: ignore[attr-defined]
        cto = await session.scalar(
            select(Employee).where(Employee.role == "Chief Technology Officer")
        )
    conversation = (
        await apps_client.post(
            "/api/conversations", json={"kind": "employee", "employee_id": cto.id}
        )
    ).json()
    sent = await apps_client.post(
        f"/api/conversations/{conversation['id']}/messages", data={"content": REQUEST}
    )
    assert sent.status_code == 201, sent.text
    message_id = sent.json()["message"]["id"]
    r = await apps_client.post("/api/apps", json={"source_message_id": message_id})
    assert r.status_code == 201 and r.json()["description"] == REQUEST
    app_id = r.json()["id"]
    await wait_for(apps_client, app_id, "awaiting_approval")
    await apps_client.post(f"/api/apps/{app_id}/approve")
    await wait_for(apps_client, app_id, "ready", "failed")
    messages = (await apps_client.get(f"/api/conversations/{conversation['id']}/messages")).json()
    notices = [m["content"] for m in messages if m["role"] == "system"]
    assert any("Nothing is written until you approve" in n for n in notices)
    assert all(f"(/apps/{app_id})" in n for n in notices)
    report = [m for m in messages if m["role"] == "agent"][-1]
    assert report["author_name"] == cto.name and report["content"].startswith(
        "**App ready — Team Notes**"
    )
    assert (
        await apps_client.post("/api/apps", json={"source_message_id": report["id"]})
    ).status_code == 404


def test_files_are_never_written_through_links(tmp_path: Path) -> None:
    root, outside = tmp_path / "work", tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    (outside / "keep.txt").write_text("mine")
    (root / "static").symlink_to(outside, target_is_directory=True)  # planted by a running app
    (root / "server.py").symlink_to(outside / "keep.txt")
    write_tree(root, {"static/app.js": "let a;\n", "server.py": "print(1)\n"}, ["old/gone.py"])
    assert (root / "static").is_dir() and not (root / "static").is_symlink()
    assert (root / "static" / "app.js").read_text() == "let a;\n"
    assert sorted(p.name for p in outside.iterdir()) == ["keep.txt"]  # nothing written outside
    assert (outside / "keep.txt").read_text() == "mine"

    (root / "docs").symlink_to(outside, target_is_directory=True)
    write_tree(root, {"server.py": "print(2)\n"}, ["docs/keep.txt", "static/app.js"])
    assert (outside / "keep.txt").exists()  # an old path behind a link is not deleted
    assert not (root / "static" / "app.js").exists()


def test_dependencies_are_listed_for_the_approval() -> None:
    listed = dependencies(
        {
            "requirements.txt": "flask==3.0  # web\n\n# comment\nrequests\n",
            "frontend/package.json": json.dumps(
                {"dependencies": {"react": "^19"}, "devDependencies": {"vite": "^7"}}
            ),
            "server.py": "import flask",
        }
    )
    assert listed == [
        {"file": "frontend/package.json", "registry": "npm", "packages": ["react ^19", "vite ^7"]},
        {"file": "requirements.txt", "registry": "PyPI", "packages": ["flask==3.0", "requests"]},
    ]
