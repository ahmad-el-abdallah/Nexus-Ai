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
from collections.abc import Mapping, Sequence
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
    uv: Path | None = None  # installs an app's Python packages (apps only)


def _uv() -> Path | None:
    found = os.environ.get("UV") or shutil.which("uv")  # `uv run` sets UV to itself
    return Path(os.path.realpath(found)) if found and Path(found).is_file() else None


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
    return Capabilities(True, languages, None, prefix, _uv())


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


@dataclass(frozen=True)
class Limits:
    memory: str = MEMORY
    tasks: int = TASKS
    cpu: str = "100%"


def sandbox(
    run: Sequence[str],
    work: Path,
    caps: Capabilities,
    *,
    limits: Limits | None = None,
    node: bool = False,
    chdir: str = "/work",
    read_only: Sequence[tuple[Path, str]] = (),
    writable: Sequence[tuple[Path, str]] = (),
    env: Mapping[str, str] | None = None,
    path: str = "",
) -> list[str]:
    """The command line that runs `run` in the sandbox, with `work` as /work.

    Always: no network (own empty namespace), only /usr of this computer (read-only), an
    empty environment and the cgroup limits. `read_only` / `writable` add (folder or file
    here, path inside) pairs; `path` goes in front of PATH; `env` adds variables."""
    limits = limits or Limits()
    search = "/usr/bin:/bin"
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
    if node and caps.node_prefix:
        binds += ["--ro-bind", str(caps.node_prefix), "/opt/node"]
        search = "/opt/node/bin:" + search
    for source, inside in read_only:
        binds += ["--ro-bind", str(source), inside]
    if path:
        search = path + ":" + search
    variables = {"PATH": search, "HOME": "/work", "LANG": "C.UTF-8", **(env or {})}
    return [
        "systemd-run", "--user", "--scope", "--quiet", "--collect",
        "-p", f"MemoryMax={limits.memory}", "-p", "MemorySwapMax=0",
        "-p", f"TasksMax={limits.tasks}", "-p", f"CPUQuota={limits.cpu}",
        "bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
        *binds,
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",  # noqa: S108 - the sandbox's own empty /tmp
        "--bind", str(work), "/work",
        *(arg for source, inside in writable for arg in ("--bind", str(source), inside)),
        "--chdir", chdir,
        *(arg for name, value in variables.items() for arg in ("--setenv", name, value)),
        *run,
    ]  # fmt: skip


def command(work: Path, language: str, caps: Capabilities) -> list[str]:
    _, run = LANGUAGES[language]
    return sandbox(
        run, work, caps, node=language == "javascript", env={"PYTHONDONTWRITEBYTECODE": "1"}
    )


def execute(argv: Sequence[str], timeout: float) -> tuple[int | None, bytes, bytes, bool]:
    """Runs a sandbox command line to its end: (exit code, stdout, stderr, timed out).
    On a timeout its whole process group is killed and the exit code is None."""
    process = subprocess.Popen(  # noqa: S603 - fixed argv, no shell
        list(argv),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        out, err = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        out, err = process.communicate()
        return None, out, err, True
    return process.returncode, out, err, False


def run(code: str, language: str, work: Path, keep: Path) -> Outcome:
    """Runs `code` in an empty `work` folder; files it writes are copied to `keep`."""
    caps = capabilities()
    if not caps.available or language not in caps.languages:
        raise RuntimeError(caps.reason or f"{language} isn't available in the sandbox.")
    work.mkdir(parents=True, exist_ok=True)
    source, _ = LANGUAGES[language]
    (work / source).write_text(code, encoding="utf-8")
    started = time.perf_counter()
    code_, out, err, timed_out = execute(command(work, language, caps), TIMEOUT_S)
    duration = int((time.perf_counter() - started) * 1000)
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
