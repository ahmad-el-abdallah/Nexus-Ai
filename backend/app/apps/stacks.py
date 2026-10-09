"""The kinds of web application the team can build, and how NEXUS installs and starts them.

Everything that gets executed is defined here, in code: a model chooses one of these
stacks and writes files, but never decides which commands run or where files may go.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass

MAX_FILES = 16
MAX_FILE_CHARS = 60_000
APP_PORT = 8000  # inside the sandbox's own network; never a port on this computer

AREAS = ("backend", "frontend", "setup", "docs")
# Setup files come after the code, so they list the packages the code really uses.
WRITE_ORDER = ("backend", "frontend", "setup", "docs")

EXTENSIONS = {
    ".py", ".js", ".mjs", ".cjs", ".jsx", ".html", ".css", ".json", ".md", ".txt", ".svg",
    ".sql", ".csv",
}  # fmt: skip
# Folders NEXUS or the running app own; no file of the app may be written there.
RESERVED = {"node_modules", "data", "dist", "build", "venv", "env", "__pycache__"}
_SEGMENT = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$")
SETUP_NAMES = {"requirements.txt", "package.json"}

OFFLINE = (
    "The app runs without internet access: no CDN links, web fonts, analytics or calls "
    "to external services. Everything it needs is in its own files or installed packages."
)


@dataclass(frozen=True)
class Step:
    label: str
    argv: tuple[str, ...]
    cwd: str = ""  # folder inside the app, "" for its root
    needs: str = ""  # only when this file exists


@dataclass(frozen=True)
class Stack:
    key: str
    name: str
    description: str  # for the architect choosing a stack
    rules: tuple[str, ...]  # the contract every file must follow
    required: tuple[str, ...]
    frontend_dirs: tuple[str, ...]
    install: tuple[Step, ...]
    build: tuple[Step, ...]
    start: tuple[str, ...]


_PYTHON_INSTALL = (
    Step(
        "Create the Python environment",
        ("uv", "venv", ".venv", "--python", "/usr/bin/python3"),
        needs="requirements.txt",
    ),
    Step(
        "Install the Python packages",
        ("uv", "pip", "install", "--python", ".venv/bin/python", "-r", "requirements.txt"),
        needs="requirements.txt",
    ),
)
_NPM_INSTALL = ("npm", "install", "--no-audit", "--no-fund", "--loglevel=error")

_PYTHON_BACKEND = (
    "Backend: `server.py` in the app's root folder is the entry point; NEXUS starts it with "
    "`python3 server.py`. It must listen on host 127.0.0.1 and on the port given in the PORT "
    "environment variable (default 8000), and serve the JSON API under `/api/...`.",
    "Use the Python standard library, or packages listed in `requirements.txt` (for example "
    "Flask). Pin nothing exotic: only well-known packages from PyPI.",
    "The database is SQLite (`sqlite3`). Keep the database file and any other stored data "
    "under `./data/` (create the folder at startup if it is missing).",
)

STACKS: dict[str, Stack] = {
    stack.key: stack
    for stack in (
        Stack(
            key="python",
            name="Python backend + plain web frontend",
            description="A Python server (standard library or Flask) with an HTML/CSS/JavaScript "
            "frontend and no build step. The simplest and most reliable choice.",
            rules=(
                *_PYTHON_BACKEND,
                "The same server serves the frontend from the `static/` folder: "
                "`static/index.html` at `/`, the other files under `/static/...`.",
                "Frontend: plain HTML, CSS and JavaScript in `static/` — no frameworks, no "
                "build step. Call the API with relative URLs such as `/api/items`.",
                OFFLINE,
            ),
            required=("server.py", "static/index.html"),
            frontend_dirs=("static",),
            install=_PYTHON_INSTALL,
            build=(),
            start=("python3", "server.py"),
        ),
        Stack(
            key="node",
            name="Node.js backend + plain web frontend",
            description="A Node.js server (built-in modules or Express) with an "
            "HTML/CSS/JavaScript frontend and no build step.",
            rules=(
                "Backend: `server.js` in the app's root folder is the entry point; NEXUS starts "
                "it with `node server.js`. It must listen on host 127.0.0.1 and on the port given "
                "in the PORT environment variable (default 8000), and serve the JSON API under "
                "`/api/...`.",
                "`package.json` lists every package the code requires (for example express). Use "
                "only pure-JavaScript packages: nothing that compiles native code or downloads "
                "binaries when installed.",
                "Store data as JSON files under `./data/` (create the folder at startup if it is "
                "missing).",
                "The same server serves the frontend from the `public/` folder "
                "(`public/index.html` at `/`).",
                "Frontend: plain HTML, CSS and JavaScript in `public/` — no frameworks, no build "
                "step. Call the API with relative URLs such as `/api/items`.",
                OFFLINE,
            ),
            required=("server.js", "package.json", "public/index.html"),
            frontend_dirs=("public",),
            install=(Step("Install the npm packages", _NPM_INSTALL),),
            build=(),
            start=("node", "server.js"),
        ),
        Stack(
            key="python-react",
            name="Python backend + React frontend",
            description="A Python server with a React frontend built by Vite. Choose it only "
            "when the interface is rich enough to need components; it has more moving parts.",
            rules=(
                *_PYTHON_BACKEND,
                "The same server serves the built frontend from `frontend/dist/`: "
                "`frontend/dist/index.html` at `/` and for any path that is not `/api/...`, the "
                "built assets under `/assets/...`.",
                "Frontend: React with Vite in `frontend/`, plain JavaScript (JSX), no TypeScript. "
                '`frontend/package.json` has the script `"build": "vite build"`, the '
                "dependencies `react` and `react-dom`, and the devDependencies `vite` and "
                "`@vitejs/plugin-react`. `frontend/index.html` loads `/src/main.jsx`; components "
                "live in `frontend/src/`. Call the API with relative URLs such as `/api/items`.",
                OFFLINE,
            ),
            required=(
                "server.py",
                "frontend/package.json",
                "frontend/vite.config.js",
                "frontend/index.html",
                "frontend/src/main.jsx",
            ),
            frontend_dirs=("frontend",),
            install=(
                *_PYTHON_INSTALL,
                Step("Install the npm packages", _NPM_INSTALL, cwd="frontend"),
            ),
            build=(Step("Build the frontend", ("npm", "run", "build"), cwd="frontend"),),
            start=("python3", "server.py"),
        ),
    )
}


def clean_path(path: str) -> str:
    """A safe, normalised relative path for a file of an app; ValueError says why not."""
    path = path.strip().replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    if not path or len(path) > 120:
        raise ValueError("a file path must be 1 to 120 characters long")
    parts = path.split("/")
    if len(parts) > 5:
        raise ValueError(f"'{path}' is nested too deeply (at most 5 levels)")
    for part in parts:
        if not _SEGMENT.match(part):
            raise ValueError(
                f"'{path}' is not allowed: use relative paths made of letters, digits, '_', "
                "'-' and '.', with no part starting with a dot"
            )
    if any(part.lower() in RESERVED for part in parts[:-1]) or parts[0].lower() in RESERVED:
        raise ValueError(f"'{path}' is inside a folder that is created when the app runs")
    name = parts[-1]
    extension = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if extension not in EXTENSIONS:
        raise ValueError(
            f"'{path}' has a file type that isn't supported (text files only: "
            + ", ".join(sorted(EXTENSIONS))
            + ")"
        )
    return path


def area_of(stack: Stack, path: str) -> str:
    """Which part of the app a file belongs to — this decides whose role writes it."""
    name = path.rsplit("/", 1)[-1]
    lower = name.lower()
    if lower in SETUP_NAMES or lower.startswith("vite.config."):
        return "setup"
    if lower.endswith((".md", ".txt")):
        return "docs"
    if "/" in path and path.split("/", 1)[0] in stack.frontend_dirs:
        return "frontend"
    if lower.endswith((".html", ".css", ".jsx", ".svg")):
        return "frontend"
    return "backend"


def tree_sha256(files: dict[str, str]) -> str:
    """One hash over every path and content: the exact app the owner approves to run."""
    digest = hashlib.sha256()
    for path in sorted(files):
        digest.update(path.encode())
        digest.update(b"\0")
        digest.update(hashlib.sha256(files[path].encode()).digest())
        digest.update(b"\n")
    return digest.hexdigest()


def is_dependency_file(path: str) -> bool:
    return path.rsplit("/", 1)[-1] in SETUP_NAMES


def dependencies_sha256(files: dict[str, str]) -> str:
    return tree_sha256({p: c for p, c in files.items() if is_dependency_file(p)})


def dependencies(files: dict[str, str]) -> list[dict[str, object]]:
    """The packages an install would download, as the dependency files list them."""
    listed: list[dict[str, object]] = []
    for path in sorted(files):
        name = path.rsplit("/", 1)[-1]
        if name == "requirements.txt":
            packages = [
                line.split("#", 1)[0].strip()
                for line in files[path].splitlines()
                if line.split("#", 1)[0].strip()
            ]
            listed.append({"file": path, "registry": "PyPI", "packages": packages})
        elif name == "package.json":
            try:
                data = json.loads(files[path])
                packages = [
                    f"{pkg} {version}"
                    for section in ("dependencies", "devDependencies")
                    for pkg, version in (data.get(section) or {}).items()
                ]
            except (ValueError, AttributeError):
                packages = ["(package.json could not be read)"]
            listed.append({"file": path, "registry": "npm", "packages": packages})
    return listed
