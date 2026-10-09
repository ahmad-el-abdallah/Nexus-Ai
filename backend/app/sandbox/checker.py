"""Runs inside the sandbox: checks an app's files for syntax errors without running them.

Looks at every file under the current folder and prints one JSON object:
  {"files":   {path: {"ok": true | false, "error": "..."}},   only files it can check
   "imports": {path: ["flask", ...]}}                          third-party Python imports
Python files are parsed and compiled (not executed); JavaScript goes through
`node --check`. Standard library only.
"""

import ast
import json
import os
import shutil
import subprocess
import sys

JAVASCRIPT = (".js", ".mjs", ".cjs")


def python_file(path, source, local):
    try:
        tree = ast.parse(source, filename=path)
        compile(tree, path, "exec", dont_inherit=True)
    except SyntaxError as error:
        line = (error.text or "").strip()
        where = f"line {error.lineno}" if error.lineno else "the file"
        message = f"{where}: {error.msg}" + (f" — {line}" if line else "")
        return {"ok": False, "error": message}, []
    except (ValueError, RecursionError, MemoryError) as error:
        return {"ok": False, "error": f"could not be parsed: {error}"}, []
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    standard = getattr(sys, "stdlib_module_names", None)
    third_party = sorted(names - set(standard) - local) if standard else []
    return {"ok": True, "error": ""}, third_party


def javascript_file(node, path):
    try:
        result = subprocess.run(  # noqa: S603 - fixed argv; --check parses, it doesn't run
            [node, "--check", path], capture_output=True, text=True, timeout=20
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode == 0:
        return {"ok": True, "error": ""}
    lines = [ln for ln in result.stderr.splitlines() if ln.strip() and "node:internal" not in ln]
    return {"ok": False, "error": "\n".join(lines[:6])[:600]}


def main():
    node = shutil.which("node")
    paths = []
    for folder, _, names in os.walk("."):
        for name in names:
            paths.append(os.path.relpath(os.path.join(folder, name), ".").replace(os.sep, "/"))
    local = {p.split("/")[0].rsplit(".", 1)[0] for p in paths}
    files, imports = {}, {}
    for path in sorted(paths):
        lower = path.lower()
        if lower.endswith(".py"):
            with open(path, encoding="utf-8", errors="replace") as handle:
                files[path], found = python_file(path, handle.read(), local)
            if found:
                imports[path] = found
        elif lower.endswith(JAVASCRIPT) and node:
            outcome = javascript_file(node, path)
            if outcome is not None:
                files[path] = outcome
    json.dump({"files": files, "imports": imports}, sys.stdout)


if __name__ == "__main__":
    main()
