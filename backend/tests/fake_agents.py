"""Canned agent replies for workflow tests (unit and e2e) — no real model involved.

Each workflow prompt names its reply format ("Format: NEXUS-PLAN/1", …); this
answers with a valid reply built from what the prompt lists (departments, team).
"""

from __future__ import annotations

import json
import re

PREFERRED = ("research", "engineering")


def _departments(prompt: str) -> list[str]:
    return re.findall(r"^- ([a-z0-9-]+) — ", prompt, flags=re.MULTILINE)


def _team(prompt: str) -> list[str]:
    section = prompt.split("Your team", 1)[-1]
    return re.findall(r"^- (.+?) — ", section, flags=re.MULTILINE)


# A tiny real app (standard library only), so tests can check, store and run it.
APP_SERVER = """import json
import os
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)
NOTES = DATA / "notes.json"
KINDS = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}


def load():
    return json.loads(NOTES.read_text()) if NOTES.exists() else []


def probe():
    try:
        urllib.request.urlopen("https://example.com", timeout=3)
        network = "open"
    except Exception as error:
        network = type(error).__name__
    return {"network": network, "env": sorted(os.environ), "home": os.path.expanduser("~")}


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body, kind="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/api/notes":
            return self.reply(200, load())
        if self.path == "/api/probe":
            return self.reply(200, probe())
        name = "index.html" if self.path == "/" else self.path.removeprefix("/static/")
        file = (STATIC / name).resolve()
        if file.is_file() and STATIC.resolve() in file.parents:
            return self.reply(200, file.read_bytes(), KINDS.get(file.suffix, "text/plain"))
        return self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/api/notes":
            return self.reply(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        text = str(json.loads(self.rfile.read(length) or b"{}").get("text", ""))
        notes = load()
        notes.append({"id": len(notes) + 1, "text": text})
        NOTES.write_text(json.dumps(notes))
        return self.reply(201, notes[-1])

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"Team Notes is listening on 127.0.0.1:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
"""
APP_FILES = {
    "server.py": ("python", APP_SERVER),
    "static/index.html": (
        "html",
        "<!doctype html>\n<html>\n<head><title>Team Notes</title></head>\n<body>\n"
        '<h1>Team Notes</h1>\n<form id="add"><input id="text" aria-label="Note">'
        "<button>Add</button></form>\n"
        '<ul id="notes"></ul>\n<script src="/static/app.js"></script>\n</body>\n</html>\n',
    ),
    "static/app.js": (
        "javascript",
        "const list = document.getElementById('notes');\n"
        "async function load() {\n"
        "  const notes = await (await fetch('/api/notes')).json();\n"
        "  list.innerHTML = '';\n"
        "  for (const note of notes) {\n"
        "    const item = document.createElement('li');\n"
        "    item.textContent = note.text;\n"
        "    list.appendChild(item);\n"
        "  }\n"
        "}\n"
        "document.getElementById('add').addEventListener('submit', async (event) => {\n"
        "  event.preventDefault();\n"
        "  const text = document.getElementById('text').value;\n"
        "  await fetch('/api/notes', { method: 'POST', body: JSON.stringify({ text }) });\n"
        "  load();\n"
        "});\n"
        "load();\n",
    ),
    "static/about.html": (
        "html",
        "<!doctype html>\n<html>\n<body>\n<h1>About Team Notes</h1>\n"
        '<a href="/">Back</a>\n</body>\n</html>\n',
    ),
    "README.md": (
        "markdown",
        "# Team Notes\n\nA shared list of notes.\n\nRun it:\n\n```bash\npython3 server.py\n```\n",
    ),
}


def _app_file(prompt: str) -> str:
    """The file the prompt asks for, in one code block (as the format requires)."""
    found = re.search(r"^Your file: `([^`]+)`", prompt, flags=re.MULTILINE)
    path = found.group(1) if found else ""
    language, content = APP_FILES.get(path, ("text", f"placeholder for {path}\n"))
    if "WHAT TO CHANGE" in prompt and path == "static/index.html":
        content = content.replace("</ul>", '</ul>\n<a href="/static/about.html">About</a>')
    return f"```{language}\n{content}```"


def canned_reply(prompt: str) -> str | None:
    if "Format: NEXUS-APPPLAN/1" in prompt:
        return json.dumps(
            {
                "name": "Team Notes",
                "summary": "A small app where the team keeps a shared list of notes. "
                "Notes are stored on the server and shown in the browser.",
                "stack": "python",
                "api": "GET /api/notes -> [{id, text}]; POST /api/notes {text} -> {id, text}",
                "packages": [],
                "files": [
                    {"path": "static/index.html", "purpose": "The page with the notes list."},
                    {
                        "path": "server.py",
                        "purpose": "HTTP server: the notes API and static files.",
                    },
                    {"path": "static/app.js", "purpose": "Loads and adds notes through the API."},
                ],
            }
        )
    if "Format: NEXUS-APPCHANGE/1" in prompt:
        return json.dumps(
            {
                "summary": "Adds an About page and links to it from the main page.",
                "files": [
                    {
                        "path": "static/index.html",
                        "action": "modify",
                        "instructions": "Add a link to /static/about.html under the notes list.",
                    },
                    {
                        "path": "static/about.html",
                        "action": "add",
                        "purpose": "A short About page.",
                        "instructions": "A heading and a link back to the main page.",
                    },
                ],
                "packages": [],
            }
        )
    if "Format: NEXUS-APPFILE/1" in prompt:
        return _app_file(prompt)
    if "Format: NEXUS-APPREVIEW/1" in prompt:
        return json.dumps({"decision": "approve", "issues": []})
    if "Format: NEXUS-APPDELIVERY/1" in prompt:
        return "## Delivered\n\nTeam Notes is stored. Press **Run app** to use it."
    if "Format: NEXUS-PLAN/1" in prompt:
        keys = _departments(prompt)
        chosen = [k for k in PREFERRED if k in keys] or keys[:2]
        assignments = [
            {
                "id": f"a{i + 1}",
                "department": key,
                "title": f"{key.replace('-', ' ').title()} deliverable",
                "instructions": f"Produce the {key} part of the objective as a short written deliverable.",
                "depends_on": [f"a{i}"] if i else [],
            }
            for i, key in enumerate(chosen)
        ]
        return json.dumps(
            {
                "summary": "Research the opportunity first, then plan the implementation.",
                "assignments": assignments,
                "deliverable": "A consolidated report with an implementation plan.",
            }
        )
    if "Format: NEXUS-BREAKDOWN/1" in prompt:
        names = _team(prompt)
        # The supervisor is listed first; give the work to two other people when possible.
        team = names[1:3] if len(names) >= 3 else names[:2]
        return json.dumps(
            {
                "approach": "Split the work between two specialists.",
                "tasks": [
                    {
                        "title": f"Part {i + 1} of the assignment",
                        "instructions": "Write your part of the department deliverable.",
                        "assignee": name,
                    }
                    for i, name in enumerate(team)
                ],
            }
        )
    if "Format: NEXUS-TASK/1" in prompt:
        return (
            "## Deliverable\n\nThe finished task: three concrete steps.\n\n1. Step one.\n2. Step two.\n3. Step three.\n\n"
            "*Assumption:* details to confirm.\n\n```python\nprint('report ready')\n"
            "open('report.txt', 'w').write('42')\n```\n"
        )
    if "Format: NEXUS-EMAIL/1" in prompt:
        return json.dumps(
            {
                "subject": "Following up on your message",
                "body": "Hello,\n\nThank you for getting in touch. [Confirm the details "
                "before sending.]\n\nBest regards,\n[Your name]",
            }
        )
    if "Format: NEXUS-REVIEW/1" in prompt:
        return json.dumps({"decision": "approve", "feedback": "Clear and usable."})
    if "Format: NEXUS-WORK/1" in prompt:
        return "## Deliverable\n\n- A concrete recommendation.\n- *Assumption:* market size needs verification."
    if "Format: NEXUS-SUMMARY/1" in prompt:
        return "## Department result\n\nCombined recommendation from the team (assumptions marked)."
    if "Format: NEXUS-REPORT/1" in prompt:
        return "## Summary\n\nThe company recommends a focused pilot.\n\n## Implementation plan\n\n1. Validate demand.\n2. Build an MVP."
    return None
