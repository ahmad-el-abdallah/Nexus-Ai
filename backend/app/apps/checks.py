"""Automatic checks of an app's files: syntax only, no model, and nothing is executed.

Python and JavaScript files are checked inside the sandbox (parsed and compiled there,
never run); JSON is parsed here. Files of other kinds, and code files when the sandbox
isn't available, are reported as not checked — never as passed.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from app.apps.files import write_tree
from app.apps.stacks import Stack
from app.core.logging import get_logger
from app.sandbox import runner

log = get_logger("nexus.apps.checks")

CHECKER = Path(runner.__file__).with_name("checker.py")
CODE = (".py", ".js", ".mjs", ".cjs")
TIMEOUT_S = 90

OK, FAILED, SKIPPED = "ok", "failed", "skipped"


@dataclass
class Report:
    # path → (ok | failed | skipped, what is wrong or why it wasn't checked)
    files: dict[str, tuple[str, str | None]] = field(default_factory=dict)
    sandboxed: bool = False

    def summary(self) -> str:
        counts = {state: sum(s == state for s, _ in self.files.values()) for state in (OK, FAILED)}
        skipped = len(self.files) - counts[OK] - counts[FAILED]
        parts = [f"{counts[OK]} passed", f"{counts[FAILED]} failed"]
        if skipped:
            parts.append(f"{skipped} not checkable")
        return ", ".join(parts)


def _sandbox_check(work: Path) -> dict[str, object]:
    caps = runner.capabilities()
    argv = runner.sandbox(
        ["python3", "-I", "/opt/nexus/checker.py"],
        work,
        caps,
        node=True,
        read_only=[(CHECKER, "/opt/nexus/checker.py")],
        env={"PYTHONDONTWRITEBYTECODE": "1"},
    )
    code, out, err, timed_out = runner.execute(argv, TIMEOUT_S)
    if timed_out or code != 0:
        raise RuntimeError(
            "the check timed out" if timed_out else err.decode(errors="replace")[-400:]
        )
    data = json.loads(out.decode(errors="replace"))
    if not isinstance(data, dict):
        raise RuntimeError("the checker's output could not be read")
    return data


async def check(files: dict[str, str], stack: Stack, scratch: Path) -> Report:
    """`scratch`: a folder of ours where the files are written for the sandbox to read."""
    report = Report()
    code_files = [p for p in files if p.lower().endswith(CODE)]
    for path, content in files.items():
        if path.lower().endswith(".json"):
            try:
                json.loads(content)
                report.files[path] = (OK, None)
            except ValueError as error:
                report.files[path] = (FAILED, f"not valid JSON: {error}")
        elif path not in code_files:
            report.files[path] = (SKIPPED, None)
    if not code_files:
        return report

    caps = runner.capabilities()
    if not caps.available or "python" not in caps.languages:
        for path in code_files:
            report.files[path] = (
                SKIPPED,
                "Not checked: the sandbox isn't available on this computer.",
            )
        return report

    work = scratch / f"check-{uuid.uuid4().hex[:10]}"
    try:
        await asyncio.to_thread(write_tree, work, files)
        data = await asyncio.to_thread(_sandbox_check, work)
    except Exception as error:  # the check itself failed: say so, don't guess
        log.warning("apps.check_failed", error=str(error))
        for path in code_files:
            report.files[path] = (SKIPPED, f"Not checked: {error}")
        return report
    finally:
        await asyncio.to_thread(shutil.rmtree, work, True)

    report.sandboxed = True
    checked = data.get("files") if isinstance(data.get("files"), dict) else {}
    imports = data.get("imports") if isinstance(data.get("imports"), dict) else {}
    for path in code_files:
        outcome = checked.get(path)  # type: ignore[union-attr]
        if not isinstance(outcome, dict):
            report.files[path] = (SKIPPED, None)
        elif outcome.get("ok"):
            report.files[path] = (OK, None)
        else:
            report.files[path] = (FAILED, str(outcome.get("error") or "syntax error")[:800])
    # A Python app that imports packages must declare them, or the install has nothing
    # to install and the app can't start.
    if stack.key.startswith("python") and "requirements.txt" not in files:
        for path, modules in imports.items():  # type: ignore[union-attr]
            if report.files.get(path, (None, None))[0] == OK and modules:
                names = ", ".join(str(m) for m in modules)
                report.files[path] = (
                    FAILED,
                    f"imports {names}, but the app has no requirements.txt: use only the "
                    "Python standard library in this file.",
                )
    return report
