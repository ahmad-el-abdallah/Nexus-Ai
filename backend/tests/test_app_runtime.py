"""Running a built app: only after the owner approves that exact version, only in the
sandbox, reachable only through the preview port — and installs reach only registries."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.apps import checks
from app.apps.runtime import AppRuntime, _Active
from app.apps.stacks import STACKS
from app.sandbox import runner
from tests import test_apps
from tests.fake_agents import APP_FILES
from tests.test_apps import build, design
from tests.test_workflows import AgentProvider

apps_client = test_apps.apps_client  # the same app, with the scripted fake agents

sandbox = pytest.mark.skipif(
    not runner.capabilities().available, reason="bubblewrap/systemd-run not available"
)


@pytest.fixture
def agents() -> AgentProvider:
    return AgentProvider()


async def wait_run(
    client: httpx.AsyncClient, app_id: str, *statuses: str, within: float = 60
) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + within
    while True:
        run = (await client.get(f"/api/apps/{app_id}")).json()["run"]
        if run and run["status"] in statuses:
            return run
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(f"run stuck: {run}")
        await asyncio.sleep(0.05)


@sandbox
async def test_syntax_is_checked_in_the_sandbox_without_running_anything(tmp_path: Path) -> None:
    marker = tmp_path / "ran"
    report = await checks.check(
        {
            "server.py": f"open({str(marker)!r}, 'w').write('x')\nimport flask\nprint('ok')\n",
            "broken.py": "def f(:\n    pass\n",
            "static/app.js": "const a = ;\n",
            "static/ok.js": "const b = 1;\n",
            "data.json": "{not json}",
            "static/index.html": "<h1>hi</h1>",
        },
        STACKS["python"],
        tmp_path / "scratch",
    )
    assert report.sandboxed and not marker.exists()  # parsed, never executed
    state = {path: result[0] for path, result in report.files.items()}
    assert state == {
        "server.py": "failed",  # imports flask without a requirements.txt
        "broken.py": "failed",
        "static/app.js": "failed",
        "static/ok.js": "ok",
        "data.json": "failed",
        "static/index.html": "skipped",
    }
    assert "line 1" in (report.files["broken.py"][1] or "")
    assert "imports flask" in (report.files["server.py"][1] or "")
    assert "SyntaxError" in (report.files["static/app.js"][1] or "")
    assert list((tmp_path / "scratch").iterdir()) == []  # nothing left behind

    listed = await checks.check(
        {"server.py": "import flask\n", "requirements.txt": "flask\n"},
        STACKS["python"],
        tmp_path / "scratch",
    )
    assert listed.files["server.py"] == ("ok", None)


@sandbox
async def test_an_app_runs_in_the_sandbox_only_after_the_owner_approves_that_version(
    apps_client: httpx.AsyncClient,
) -> None:
    app = await build(apps_client)
    assert app["status"] == "ready" and app["current"]["known_issues"] == []
    assert app["current"]["files"][0]["check"] == "ok"  # server.py, checked for real
    runtime = (await apps_client.get("/api/apps/runtime")).json()
    assert runtime["available"] and runtime["port"] and runtime["limits"]["network"] is False
    assert runtime["registries"] == ["files.pythonhosted.org", "pypi.org", "registry.npmjs.org"]
    preview = f"http://127.0.0.1:{runtime['port']}"
    tree = app["current"]["tree_sha256"]
    run_url = f"/api/apps/{app['id']}/versions/1/run"

    async with httpx.AsyncClient(timeout=10) as browser:
        nothing = await browser.get(preview)
        assert nothing.status_code == 503 and "No app is running" in nothing.text

        assert (await apps_client.post(run_url, json={"tree_sha256": "0" * 64})).status_code == 409
        assert (await apps_client.get(f"/api/apps/{app['id']}")).json()["run"] is None
        started = await apps_client.post(run_url, json={"tree_sha256": tree})
        assert started.status_code == 201, started.text
        assert started.json()["status"] == "installing" and started.json()["approved_at"]
        busy = await apps_client.post(run_url, json={"tree_sha256": tree})
        assert busy.status_code == 409 and "already running" in busy.json()["detail"]

        run = await wait_run(apps_client, app["id"], "running", "failed", "stopped")
        assert run["status"] == "running", run
        assert "No packages to install." in run["log"] and "Team Notes is listening" in run["log"]

        page = await browser.get(preview)
        assert page.status_code == 200 and "<h1>Team Notes</h1>" in page.text
        assert (await browser.get(f"{preview}/static/app.js")).text == APP_FILES["static/app.js"][1]
        added = await browser.post(f"{preview}/api/notes", json={"text": "ship it"})
        assert added.status_code == 201 and added.json() == {"id": 1, "text": "ship it"}

        inside = (await browser.get(f"{preview}/api/probe")).json()
        assert inside["network"] == "URLError"  # no internet from a running app
        assert inside["home"] == "/work"
        assert not [name for name in inside["env"] if "NVIDIA" in name or "NEXUS" in name]

        stopped = await apps_client.post(f"/api/apps/runs/{run['id']}/stop")
        assert stopped.status_code == 200 and stopped.json()["status"] == "stopped"
        assert stopped.json()["error"] == "Stopped by the owner."
        assert (await browser.get(preview)).status_code == 503
        assert (await apps_client.post(f"/api/apps/runs/{run['id']}/stop")).status_code == 409

        # The app's own data folder is kept for its next run.
        await apps_client.post(run_url, json={"tree_sha256": tree})
        await wait_run(apps_client, app["id"], "running", "failed")
        assert (await browser.get(f"{preview}/api/notes")).json() == [{"id": 1, "text": "ship it"}]

    # Deleting the app stops it and removes its folder.
    apps_dir = Path(apps_client.app.state.settings.apps_dir)  # type: ignore[attr-defined]
    assert (apps_dir / app["id"] / "work" / "data" / "notes.json").is_file()
    assert (await apps_client.delete(f"/api/apps/{app['id']}")).status_code == 204
    assert not (apps_dir / app["id"]).exists()
    assert (await apps_client.get("/api/apps/runtime")).json()["active"] is None


@sandbox
async def test_an_app_that_does_not_start_is_reported_with_its_output(
    apps_client: httpx.AsyncClient,
    agents: AgentProvider,
) -> None:
    agents.on("APPFILE", "```python\nimport sys\nprint('boom: no database')\nsys.exit(3)\n```")
    app = await build(apps_client)
    assert app["status"] == "ready"
    r = await apps_client.post(
        f"/api/apps/{app['id']}/versions/1/run",
        json={"tree_sha256": app["current"]["tree_sha256"]},
    )
    assert r.status_code == 201
    run = await wait_run(apps_client, app["id"], "failed", "running", "stopped")
    assert run["status"] == "failed"
    assert run["error"] == "The app stopped while starting (exit code 3). The log shows why."
    assert "boom: no database" in run["log"]
    assert (await apps_client.get("/api/apps/runtime")).json()["active"] is None


async def test_only_finished_versions_can_be_run(apps_client: httpx.AsyncClient) -> None:
    app = await design(apps_client)
    r = await apps_client.post(
        f"/api/apps/{app['id']}/versions/1/run", json={"tree_sha256": "0" * 64}
    )
    assert r.status_code == 409
    assert (
        await apps_client.post("/api/apps/app_x/versions/1/run", json={"tree_sha256": "0" * 64})
    ).status_code in (404, 409)
    assert (await apps_client.post("/api/apps/runs/apr_missing/stop")).status_code == 409


async def test_installs_can_reach_the_package_registries_and_nothing_else(tmp_path: Path) -> None:
    """The proxy an install talks to: CONNECT to a registry on 443, or 403."""
    seen: list[bytes] = []

    async def registry(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        seen.append(await reader.read(100))
        writer.write(b"hello from the registry")
        await writer.drain()
        writer.close()

    upstream = await asyncio.start_server(registry, "127.0.0.1", 0)
    port = upstream.sockets[0].getsockname()[1]
    runtime = AppRuntime(None, None, tmp_path, 0)  # type: ignore[arg-type]
    runtime.upstreams = {"pypi.org": ("127.0.0.1", port)}
    active = _Active("apr_test", "app_test", "Test", 1, "0" * 64)
    ctl = tmp_path / "ctl"
    ctl.mkdir()

    async def ask(request: bytes) -> bytes:
        reader, writer = await asyncio.open_unix_connection(str(ctl / "proxy.sock"))
        writer.write(request)
        await writer.drain()
        head = await reader.readuntil(b"\r\n\r\n")
        if b" 200 " in head:
            writer.write(b"GET /simple/flask/")
            await writer.drain()
        body = await reader.read(200)
        writer.close()
        return head + body

    async with runtime._proxy(active, ctl):
        ok = await ask(b"CONNECT pypi.org:443 HTTP/1.1\r\nHost: pypi.org:443\r\n\r\n")
        assert ok.startswith(b"HTTP/1.1 200") and ok.endswith(b"hello from the registry")
        assert seen == [b"GET /simple/flask/"]
        for refused in (
            b"CONNECT evil.example.com:443 HTTP/1.1\r\n\r\n",
            b"CONNECT 127.0.0.1:8000 HTTP/1.1\r\n\r\n",  # NEXUS's own API
            b"CONNECT pypi.org:22 HTTP/1.1\r\n\r\n",
            b"GET http://pypi.org/simple/ HTTP/1.1\r\n\r\n",
            b"CONNECT pypi.org.evil.example.com:443 HTTP/1.1\r\n\r\n",
        ):
            assert (await ask(refused)).startswith(b"HTTP/1.1 403"), refused
        assert len(seen) == 1  # nothing else reached a server
    assert not (ctl / "proxy.sock").exists()
    assert active.log.count("[blocked]") == 5 and "evil.example.com:443" in active.log
    if active.flush is not None:
        active.flush.cancel()
    upstream.close()
    with contextlib.suppress(Exception):
        await upstream.wait_closed()


async def test_the_preview_is_closed_when_no_app_runs(apps_client: httpx.AsyncClient) -> None:
    port = (await apps_client.get("/api/apps/runtime")).json()["port"]
    assert port  # a free port chosen for the test
    async with httpx.AsyncClient(timeout=5) as browser:
        r = await browser.get(f"http://127.0.0.1:{port}/api/employees")
        assert r.status_code == 503 and "No app is running" in r.text


# ---------------------------------------------------- real package installs (opt-in)

SERVE_DIST = """import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DIST = Path(__file__).resolve().parent / "frontend" / "dist"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST), **kwargs)

    def do_GET(self):
        if not (DIST / self.path.lstrip("/")).is_file():
            self.path = "/index.html"
        return super().do_GET()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
"""
FLASK = """import os

from flask import Flask, jsonify, send_from_directory

app = Flask(__name__, static_folder="static")


@app.get("/")
def index():
    return send_from_directory("static", "index.html")


@app.get("/api/hello")
def hello():
    return jsonify(message="hello from flask")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "8000")))
"""
EXPRESS = """const express = require('express');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/hello', (req, res) => res.json({ message: 'hello from express' }));
app.listen(process.env.PORT || 8000, '127.0.0.1', () => console.log('express is listening'));
"""
PAGE = "<!doctype html>\n<html><body><h1>Demo page</h1></body></html>\n"
REACT_PACKAGE = {
    "name": "demo",
    "private": True,
    "version": "0.0.0",
    "type": "module",
    "scripts": {"build": "vite build"},
    "dependencies": {"react": "^18.3.1", "react-dom": "^18.3.1"},
    "devDependencies": {"vite": "^5.4.0", "@vitejs/plugin-react": "^4.3.0"},
}
# Per stack: the design's files, each file's content in writing order, and what the
# running app must answer.
REAL_APPS: dict[str, tuple[list[str], list[str], str, str, list[str]]] = {
    "python": (
        ["server.py", "static/index.html"],
        [FLASK, PAGE, "flask\n", "# Demo\n"],
        "/api/hello",
        "hello from flask",
        ["flask"],
    ),
    "node": (
        ["server.js", "package.json", "public/index.html"],
        [
            EXPRESS,
            PAGE,
            json.dumps({"name": "demo", "private": True, "dependencies": {"express": "^4.19.2"}}),
            "# Demo\n",
        ],
        "/api/hello",
        "hello from express",
        ["express"],
    ),
    "python-react": (
        [
            "server.py",
            "frontend/package.json",
            "frontend/vite.config.js",
            "frontend/index.html",
            "frontend/src/main.jsx",
        ],
        [
            SERVE_DIST,
            '<!doctype html>\n<html><body><div id="root"></div>'
            '<script type="module" src="/src/main.jsx"></script></body></html>\n',
            "import React from 'react';\nimport { createRoot } from 'react-dom/client';\n\n"
            "createRoot(document.getElementById('root')).render(<h1>Hello from React</h1>);\n",
            json.dumps(REACT_PACKAGE),
            "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\n"
            "export default defineConfig({ plugins: [react()] });\n",
            "# Demo\n",
        ],
        "/",
        '<div id="root">',
        ["react", "vite"],
    ),
}


@sandbox
@pytest.mark.skipif(
    not os.environ.get("NEXUS_TEST_APP_INSTALLS"),
    reason="downloads real packages from PyPI and npm; set NEXUS_TEST_APP_INSTALLS=1",
)
@pytest.mark.parametrize("stack", list(REAL_APPS))
async def test_real_packages_are_installed_and_the_app_starts(
    apps_client: httpx.AsyncClient, agents: AgentProvider, stack: str
) -> None:
    paths, contents, route, expected, packages = REAL_APPS[stack]
    agents.on(
        "APPPLAN",
        json.dumps(
            {
                "name": f"Demo {stack}",
                "summary": "A demo app that answers one request.",
                "stack": stack,
                "packages": packages,
                "files": [{"path": p, "purpose": "Part of the demo."} for p in paths],
            }
        ),
    )
    agents.on("APPFILE", *(f"```\n{content.rstrip()}\n```" for content in contents))
    app = await build(apps_client)
    assert app["status"] == "ready" and app["current"]["known_issues"] == [], app["current"]
    assert [d["registry"] for d in app["current"]["dependencies"]]  # shown before approval
    port = (await apps_client.get("/api/apps/runtime")).json()["port"]
    run_url = f"/api/apps/{app['id']}/versions/1/run"
    tree = {"tree_sha256": app["current"]["tree_sha256"]}

    assert (await apps_client.post(run_url, json=tree)).status_code == 201
    run = await wait_run(apps_client, app["id"], "running", "failed", "stopped", within=420)
    assert run["status"] == "running", run["error"] + "\n" + run["log"]
    assert "[blocked]" not in run["log"]  # nothing outside the registries was needed
    async with httpx.AsyncClient(timeout=10) as browser:
        assert expected in (await browser.get(f"http://127.0.0.1:{port}{route}")).text
    await apps_client.post(f"/api/apps/runs/{run['id']}/stop")

    # A second start reuses what is installed.
    assert (await apps_client.post(run_url, json=tree)).status_code == 201
    again = await wait_run(apps_client, app["id"], "running", "failed", "stopped", within=60)
    assert again["status"] == "running" and "already installed" in again["log"], again["log"]
    await apps_client.post(f"/api/apps/runs/{again['id']}/stop")
