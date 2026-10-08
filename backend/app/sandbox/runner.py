"""The sandbox: bubblewrap (namespaces) inside a systemd user scope (cgroup limits).

What code can and can't do in it:
- no network at all (own, empty network namespace);
- no access to the owner's files: only the system's programs (/usr, read-only) and an
  empty work folder for this run; HOME is the work folder; the environment is empty
  (no keys or tokens);
- own process tree, killed with the run; at most 64 processes, 512 MB of memory
  (no swap), one CPU core, 30 seconds, and 5 MB of written files kept afterwards.
Nothing here asks for root.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

TIMEOUT_S = 30
MEMORY = "512M"
TASKS = 64
OUTPUT_LIMIT = 64_000  # characters of stdout / stderr kept
FILE_LIMIT = 5_000_000  # bytes of written files kept
MAX_FILES = 20

LANGUAGES = {
    # language: (file name, command)
    "python": ("main.py", ["python3", "-I", "main.py"]),
    "javascript": ("main.js", ["node", "main.js"]),
    "bash": ("main.sh", ["bash", "main.sh"]),
}
ALIASES = {
    "py": "python",
    "python3": "python",
    "js": "javascript",
    "node": "javascript",
    "nodejs": "javascript",
    "sh": "bash",
    "shell": "bash",
}


def language_of(tag: str) -> str | None:
    tag = tag.strip().lower()
    return tag if tag in LANGUAGES else ALIASES.get(tag)


@dataclass
class Capabilities:
    available: bool
    languages: list[str]
    reason: str | None = None
    node_prefix: Path | None = None


def capabilities() -> Capabilities:
    if not shutil.which("bwrap"):
        return Capabilities(
            False, [], "bubblewrap (bwrap) isn't installed: sudo apt install bubblewrap"
        )
    if not shutil.which("systemd-run"):
        return Capabilities(False, [], "systemd-run isn't available, so limits can't be enforced.")
    languages = []
    if Path("/usr/bin/python3").exists():
        languages.append("python")
    node = shutil.which("node")
    prefix = Path(os.path.realpath(node)).parent.parent if node else None
    if prefix:
        languages.append("javascript")
    if Path("/usr/bin/bash").exists():
        languages.append("bash")
    return Capabilities(True, languages, None, prefix)


@dataclass
class Outcome:
    exit_code: int | None
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool = False
    killed: bool = False
    files: list[dict[str, object]] = field(default_factory=list)


def _cap(data: bytes) -> str:
    text = data.decode("utf-8", errors="replace")
    if len(text) > OUTPUT_LIMIT:
        return text[:OUTPUT_LIMIT] + f"\n[… output cut at {OUTPUT_LIMIT} characters]"
    return text


def command(work: Path, language: str, caps: Capabilities) -> list[str]:
    _, run = LANGUAGES[language]
    path = "/usr/bin:/bin"
    binds = [
        "--ro-bind", "/usr", "/usr",
        "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/lib64", "/lib64",
        "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/sbin", "/sbin",
        "--ro-bind-try", "/etc/alternatives", "/etc/alternatives",
        "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
        "--ro-bind-try", "/etc/ssl/certs", "/etc/ssl/certs",
    ]  # fmt: skip
    if language == "javascript" and caps.node_prefix:
        binds += ["--ro-bind", str(caps.node_prefix), "/opt/node"]
        path = "/opt/node/bin:" + path
    return [
        "systemd-run", "--user", "--scope", "--quiet", "--collect",
        "-p", f"MemoryMax={MEMORY}", "-p", "MemorySwapMax=0",
        "-p", f"TasksMax={TASKS}", "-p", "CPUQuota=100%",
        "bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
        *binds,
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",  # noqa: S108 - the sandbox's own empty /tmp
        "--bind", str(work), "/work", "--chdir", "/work",
        "--setenv", "PATH", path, "--setenv", "HOME", "/work",
        "--setenv", "LANG", "C.UTF-8", "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
        *run,
    ]  # fmt: skip


def run(code: str, language: str, work: Path, keep: Path) -> Outcome:
    """Runs `code` in an empty `work` folder; files it writes are copied to `keep`."""
    caps = capabilities()
    if not caps.available or language not in caps.languages:
        raise RuntimeError(caps.reason or f"{language} isn't available in the sandbox.")
    work.mkdir(parents=True, exist_ok=True)
    source, _ = LANGUAGES[language]
    (work / source).write_text(code, encoding="utf-8")
    started = time.perf_counter()
    process = subprocess.Popen(  # noqa: S603 - fixed argv, no shell
        command(work, language, caps),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    timed_out = False
    try:
        out, err = process.communicate(timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(process.pid, signal.SIGKILL)
        out, err = process.communicate()
    duration = int((time.perf_counter() - started) * 1000)
    code_ = process.returncode
    killed = not timed_out and code_ is not None and (code_ < 0 or code_ in (137, 143))
    files = _keep_files(work, keep, source)
    return Outcome(
        exit_code=None if timed_out else code_,
        stdout=_cap(out),
        stderr=_cap(err),
        duration_ms=duration,
        timed_out=timed_out,
        killed=killed,
        files=files,
    )


def _keep_files(work: Path, keep: Path, source: str) -> list[dict[str, object]]:
    kept: list[dict[str, object]] = []
    total = 0
    for path in sorted(work.rglob("*")):
        if not path.is_file() or path.is_symlink() or path.name == source:
            continue
        if path.name.startswith(".") or "__pycache__" in path.parts:
            continue
        size = path.stat().st_size
        if len(kept) >= MAX_FILES or total + size > FILE_LIMIT:
            break
        name = str(path.relative_to(work)).replace(os.sep, "__")
        keep.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, keep / name)
        kept.append({"name": name, "size": size})
        total += size
    shutil.rmtree(work, ignore_errors=True)
    return kept
