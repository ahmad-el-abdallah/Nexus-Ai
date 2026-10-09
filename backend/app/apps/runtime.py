"""Running a finished app without downloading it — after the owner approves that
exact version, and only inside the sandbox.

  approval (the version's hash)
    → the files are written into the app's own folder
    → install   packages, in the sandbox; its only way out is a proxy here that connects
                to the package registries and to nothing else
    → build     (React only) in the sandbox, no network
    → start     in the sandbox, no network; the app's port exists only in there

The owner's browser reaches the app through one relay port on 127.0.0.1 (a separate
origin from NEXUS itself), which forwards to a Unix socket inside the app's sandbox.
One app runs at a time. What gets executed is decided by the stack definitions in
`stacks.py`, never by anything a model wrote.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import re
import signal
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.apps.builder import latest_version, version_files, written_tree
from app.apps.errors import AppError
from app.apps.files import folder_bytes, is_regular, is_socket, remove_path, write_tree
from app.apps.stacks import APP_PORT, STACKS, Stack, Step, dependencies_sha256, tree_sha256
from app.core.events import EventBus
from app.core.logging import get_logger
from app.db.session import Database
from app.models import APP_RUN_ACTIVE, App, AppRun, AppRunStatus, AppStatus
from app.orchestration.engine import new_id, now
from app.sandbox import runner

log = get_logger("nexus.apps.runtime")

# The only hosts an install can reach.
REGISTRIES = ("pypi.org", "files.pythonhosted.org", "registry.npmjs.org")
PROXY_PORT = 3128  # inside the sandbox
INSTALL_TIMEOUT_S = 300
READY_TIMEOUT_S = 40
MAX_LIFETIME_S = 60 * 60
INSTALL_LIMITS = runner.Limits(memory="1536M", tasks=256, cpu="200%")
RUN_LIMITS = runner.Limits(memory="768M", tasks=128, cpu="100%")
MAX_INSTALLED_BYTES = 800_000_000
MAX_DATA_BYTES = 500_000_000
LOG_CHARS = 64_000
_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\r")
BRIDGE = Path(runner.__file__).with_name("bridge.py")
BRIDGE_ARGV = ("python3", "-I", "/opt/nexus/bridge.py")


class _Stop(Exception):
    """The run ends here, with this status and this explanation."""

    def __init__(self, status: AppRunStatus, reason: str) -> None:
        super().__init__(reason)
        self.status = status
        self.reason = reason


@dataclass(eq=False)
class _Active:
    run_id: str
    app_id: str
    app_name: str
    version: int
    tree: str
    status: str = AppRunStatus.INSTALLING.value
    log: str = ""
    socket: Path | None = None
    process: asyncio.subprocess.Process | None = None
    reader: asyncio.Task[None] | None = None
    task: asyncio.Task[None] | None = None
    stop_reason: str | None = None
    flush: asyncio.TimerHandle | None = None


def run_out(run: AppRun) -> dict[str, Any]:
    return {
        "id": run.id,
        "app_id": run.app_id,
        "version": run.version,
        "tree_sha256": run.tree_sha256,
        "status": run.status,
        "error": run.error,
        "log": run.log,
        "approved_at": run.approved_at.isoformat() if run.approved_at else None,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
    }


async def _pipe(
    a_reader: asyncio.StreamReader,
    a_writer: asyncio.StreamWriter,
    b_reader: asyncio.StreamReader,
    b_writer: asyncio.StreamWriter,
) -> None:
    """Copies both ways until both sides are done; an end-of-stream is passed on."""

    async def copy(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        with contextlib.suppress(OSError):
            while data := await reader.read(65536):
                writer.write(data)
                await writer.drain()
            if writer.can_write_eof():
                writer.write_eof()

    try:
        await asyncio.gather(copy(a_reader, b_writer), copy(b_reader, a_writer))
    finally:
        for writer in (a_writer, b_writer):
            with contextlib.suppress(Exception):
                writer.close()


class AppRuntime:
    def __init__(
        self, database: Database, events: EventBus, apps_dir: Path, preview_port: int
    ) -> None:
        self.database = database
        self.events = events
        self.apps_dir = apps_dir
        self.preview_port = preview_port
        self.port: int | None = None  # the relay's real port once it is open
        self.relay_error: str | None = None
        self.active: _Active | None = None
        self.registry_hosts: set[str] = set(REGISTRIES)
        self.upstreams: dict[str, tuple[str, int]] = {}  # tests point registries at a fake
        self._relay: asyncio.Server | None = None
        self._lock = asyncio.Lock()
        self._connections: set[asyncio.Task[Any]] = set()
        self._background: set[asyncio.Task[Any]] = set()

    # ============================================================== lifecycle

    async def startup(self) -> None:
        try:
            self._relay = await asyncio.start_server(
                self._relay_client, "127.0.0.1", self.preview_port
            )
        except OSError as error:
            self.relay_error = (
                f"port {self.preview_port} could not be opened ({error.strerror or error}). "
                "Set NEXUS_PREVIEW_PORT to a free port."
            )
            log.warning("apps.relay_unavailable", port=self.preview_port, error=str(error))
            return
        self.port = self._relay.sockets[0].getsockname()[1]

    async def recover(self) -> None:
        """After a restart no app is running."""
        async with self.database.sessionmaker() as session:
            for run in await session.scalars(
                select(AppRun).where(AppRun.status.in_([s.value for s in APP_RUN_ACTIVE]))
            ):
                run.status = AppRunStatus.STOPPED.value
                run.error = "NEXUS restarted while the app was running."
                run.finished_at = now()
            await session.commit()

    async def shutdown(self) -> None:
        if self.active is not None:
            await self._stop(self.active, "NEXUS is shutting down.")
        if self._relay is not None:
            self._relay.close()
        for task in list(self._connections | self._background):
            task.cancel()

    def capabilities(self) -> dict[str, Any]:
        caps = runner.capabilities()
        return {
            "available": caps.available and self._relay is not None,
            "reason": caps.reason if not caps.available else self.relay_error,
            "port": self.port,
            "python_packages": caps.uv is not None,
            "node": caps.node_prefix is not None,
            "registries": sorted(self.registry_hosts),
            "limits": {
                "memory": RUN_LIMITS.memory,
                "processes": RUN_LIMITS.tasks,
                "minutes": MAX_LIFETIME_S // 60,
                "install_minutes": INSTALL_TIMEOUT_S // 60,
                "network": False,
                "files": "its own folder only; your files are not visible",
            },
            "active": (
                {
                    "run_id": self.active.run_id,
                    "app_id": self.active.app_id,
                    "app_name": self.active.app_name,
                    "version": self.active.version,
                    "status": self.active.status,
                }
                if self.active
                else None
            ),
        }

    # =============================================================== owner API

    async def start(self, session: AsyncSession, app_id: str, number: int, tree: str) -> AppRun:
        """The owner's approval of this exact version (by its hash); it is installed
        and started in the sandbox."""
        caps = runner.capabilities()
        if not caps.available:
            raise AppError(f"The sandbox isn't available: {caps.reason}")
        if self._relay is None:
            raise AppError(f"The app preview isn't available: {self.relay_error}")
        app = await session.get(App, app_id)
        version = await latest_version(session, app_id, number) if app else None
        if app is None or version is None:
            raise AppError("App version not found.", 404)
        if version.status != AppStatus.READY or not version.tree_sha256:
            raise AppError("Only a finished version can be run.")
        files = written_tree(await version_files(session, version.id))
        if tree != version.tree_sha256 or tree_sha256(files) != version.tree_sha256:
            raise AppError(
                "The approved version doesn't match the stored files. Reload the page and "
                "approve again."
            )
        stack = STACKS.get(version.stack or "")
        if stack is None:
            raise AppError("This version has no known stack, so it can't be run.")
        self._require_tools(stack, files, caps)
        async with self._lock:
            if self.active is not None:
                raise AppError(f"“{self.active.app_name}” is already running. Stop it first.")
            run = AppRun(
                id=new_id("apr"),
                app_id=app_id,
                version=number,
                tree_sha256=tree,
                status=AppRunStatus.INSTALLING.value,
                approved_at=now(),
                log="",
            )
            session.add(run)
            await session.commit()
            await session.refresh(run)
            active = _Active(run.id, app_id, app.name, number, tree)
            self.active = active
            active.task = asyncio.create_task(
                self._run(active, stack, files, caps), name=f"app-run-{run.id}"
            )
        log.info("apps.run_approved", run_id=run.id, app_id=app_id, version=number)
        self.events.publish("app.run", run_out(run))
        return run

    async def stop(self, run_id: str, reason: str = "Stopped by the owner.") -> None:
        active = self.active
        if active is None or active.run_id != run_id:
            raise AppError("This app isn't running.")
        await self._stop(active, reason)

    async def stop_app(self, app_id: str, reason: str) -> None:
        if self.active is not None and self.active.app_id == app_id:
            await self._stop(self.active, reason)

    async def remove(self, app_id: str) -> None:
        """Stops the app and deletes its folder (packages and stored data included)."""
        await self.stop_app(app_id, "The app was deleted.")
        await asyncio.to_thread(remove_path, self.apps_dir / app_id)

    async def _stop(self, active: _Active, reason: str) -> None:
        active.stop_reason = reason
        task = active.task
        if task is not None and not task.done():
            task.cancel()
            await asyncio.wait([task], timeout=20)

    @staticmethod
    def _require_tools(stack: Stack, files: dict[str, str], caps: runner.Capabilities) -> None:
        if "python" not in caps.languages:
            raise AppError("Python 3 isn't installed in /usr/bin, so apps can't be run here.")
        steps = [s for s in (*stack.install, *stack.build) if not s.needs or s.needs in files]
        tools = {s.argv[0] for s in steps} | {stack.start[0]}
        if "uv" in tools and caps.uv is None:
            raise AppError("uv isn't installed, so the app's Python packages can't be installed.")
        if tools & {"npm", "node"} and caps.node_prefix is None:
            raise AppError("Node.js isn't installed, so this app can't be run here.")

    # ==================================================================== run

    async def _run(
        self, active: _Active, stack: Stack, files: dict[str, str], caps: runner.Capabilities
    ) -> None:
        status, error = AppRunStatus.FAILED, None
        root = self.apps_dir / active.app_id
        work, ctl, state = root / "work", root / "ctl", root / "state"
        try:
            await asyncio.to_thread(self._write_files, work, ctl, state, files)
            await self._install(active, stack, files, caps, work, ctl, state)
            await self._build(active, stack, caps, work, ctl, state)
            await self._serve(active, stack, caps, work, ctl)
        except _Stop as stop:
            status, error = stop.status, stop.reason
        except asyncio.CancelledError:
            status, error = AppRunStatus.STOPPED, active.stop_reason or "Stopped."
        except Exception as crash:
            log.exception("apps.run_crashed", run_id=active.run_id)
            error = f"Internal error while running the app: {crash}"
        finally:
            await asyncio.shield(self._finish(active, status, error))

    def _write_files(self, work: Path, ctl: Path, state: Path, files: dict[str, str]) -> None:
        support = self.apps_dir / "_support"
        for folder in (support, work, ctl, state):
            folder.mkdir(parents=True, exist_ok=True)
        uid = os.getuid() if hasattr(os, "getuid") else 0
        gid = os.getgid() if hasattr(os, "getgid") else 0
        # What a program expects to find in /etc; nothing of this computer's own.
        (support / "hosts").write_text("127.0.0.1 localhost\n::1 localhost\n")
        (support / "passwd").write_text(f"app:x:{uid}:{gid}:NEXUS app:/work:/bin/sh\n")
        (support / "group").write_text(f"app:x:{gid}:\n")
        manifest = state / "files.txt"
        previous = manifest.read_text().splitlines() if manifest.is_file() else []
        write_tree(work, files, previous)
        manifest.write_text("\n".join(sorted(files)) + "\n")

    def _read_only(self, caps: runner.Capabilities) -> list[tuple[Path, str]]:
        support = self.apps_dir / "_support"
        binds = [
            (BRIDGE, "/opt/nexus/bridge.py"),
            (support / "hosts", "/etc/hosts"),
            (support / "passwd", "/etc/passwd"),
            (support / "group", "/etc/group"),
        ]
        if caps.uv is not None:
            binds.append((caps.uv, "/opt/nexus/bin/uv"))
        return binds

    async def _install(
        self,
        active: _Active,
        stack: Stack,
        files: dict[str, str],
        caps: runner.Capabilities,
        work: Path,
        ctl: Path,
        state: Path,
    ) -> None:
        steps = [s for s in stack.install if not s.needs or s.needs in files]
        if not steps:
            self._log(active, "No packages to install.\n")
            return
        wanted = dependencies_sha256(files)
        marker = state / "packages.sha256"
        python = any(s.argv[0] == "uv" for s in steps)
        modules = [work / s.cwd / "node_modules" for s in steps if s.argv[0] == "npm"]
        installed = (
            marker.is_file()
            and marker.read_text().strip() == wanted
            and (not python or (work / ".venv").is_dir())
            and all(m.is_dir() for m in modules)
        )
        if installed:
            self._log(active, "The packages are already installed.\n")
            return
        marker.unlink(missing_ok=True)
        if python:
            await asyncio.to_thread(remove_path, work / ".venv")
        self._log(
            active,
            "Installing packages in the sandbox. The only sites it can reach are "
            + ", ".join(sorted(self.registry_hosts))
            + ".\n",
        )
        async with self._proxy(active, ctl):
            for step in steps:
                await self._command(active, step, caps, work, ctl, proxy=True)
        await asyncio.to_thread(remove_path, work / ".cache")
        size = await asyncio.to_thread(folder_bytes, work)
        if size > MAX_INSTALLED_BYTES:
            for folder in (work / ".venv", *modules):
                await asyncio.to_thread(remove_path, folder)
            raise _Stop(
                AppRunStatus.FAILED,
                f"The installed packages take {size // 1_000_000} MB; the limit is "
                f"{MAX_INSTALLED_BYTES // 1_000_000} MB. They were removed.",
            )
        marker.write_text(wanted)

    async def _build(
        self,
        active: _Active,
        stack: Stack,
        caps: runner.Capabilities,
        work: Path,
        ctl: Path,
        state: Path,
    ) -> None:
        if not stack.build:
            return
        marker = state / "build.sha256"
        if marker.is_file() and marker.read_text().strip() == active.tree:
            self._log(active, "The frontend is already built for this version.\n")
            return
        marker.unlink(missing_ok=True)
        for step in stack.build:
            await self._command(active, step, caps, work, ctl, proxy=False)
        marker.write_text(active.tree)

    async def _command(
        self,
        active: _Active,
        step: Step,
        caps: runner.Capabilities,
        work: Path,
        ctl: Path,
        *,
        proxy: bool,
    ) -> None:
        """One install or build command, to its end, with its output in the log."""
        self._log(active, f"\n▸ {step.label}\n")
        env = {"CI": "1", "NO_COLOR": "1", "PYTHONDONTWRITEBYTECODE": "1"}
        inner: list[str] = list(step.argv)
        if proxy:
            url = f"http://127.0.0.1:{PROXY_PORT}"
            env |= {
                "HTTPS_PROXY": url, "https_proxy": url, "HTTP_PROXY": url, "http_proxy": url,
                "UV_PYTHON_DOWNLOADS": "never", "UV_PYTHON_PREFERENCE": "only-system",
                "UV_CACHE_DIR": "/work/.cache/uv", "UV_LINK_MODE": "copy", "UV_NO_PROGRESS": "1",
                "npm_config_cache": "/work/.cache/npm", "npm_config_update_notifier": "false",
            }  # fmt: skip
            inner = [*BRIDGE_ARGV, "--proxy", str(PROXY_PORT), "/ctl/proxy.sock", "--", *inner]
        argv = runner.sandbox(
            inner,
            work,
            caps,
            limits=INSTALL_LIMITS,
            node=True,
            chdir="/work" + (f"/{step.cwd}" if step.cwd else ""),
            read_only=self._read_only(caps),
            writable=[(ctl, "/ctl")],
            env=env,
            path="/opt/nexus/bin",
        )
        process = await self._spawn(active, argv)
        try:
            code = await asyncio.wait_for(process.wait(), INSTALL_TIMEOUT_S)
        except TimeoutError:
            raise _Stop(
                AppRunStatus.FAILED,
                f"“{step.label}” took longer than {INSTALL_TIMEOUT_S // 60} minutes and was stopped.",
            ) from None
        await self._drain(active)
        if code != 0:
            raise _Stop(
                AppRunStatus.FAILED,
                f"“{step.label}” failed (exit code {code}). The log shows why.",
            )

    async def _serve(
        self, active: _Active, stack: Stack, caps: runner.Capabilities, work: Path, ctl: Path
    ) -> None:
        """Starts the app and stays with it until it ends (always by raising _Stop)."""
        socket_path, ready = ctl / "http.sock", ctl / "ready"
        remove_path(socket_path)
        remove_path(ready)
        env = {
            "PORT": str(APP_PORT), "HOST": "127.0.0.1", "PYTHONUNBUFFERED": "1",
            "PYTHONDONTWRITEBYTECODE": "1", "NODE_ENV": "production", "NO_COLOR": "1",
        }  # fmt: skip
        venv = (work / ".venv" / "bin").is_dir()
        if venv:
            env["VIRTUAL_ENV"] = "/work/.venv"
        served = ["--serve", "/ctl/http.sock", str(APP_PORT), "--ready", "/ctl/ready"]
        argv = runner.sandbox(
            [*BRIDGE_ARGV, *served, "--", *stack.start],
            work,
            caps,
            limits=RUN_LIMITS,
            node=True,
            read_only=self._read_only(caps),
            writable=[(ctl, "/ctl")],
            env=env,
            path="/work/.venv/bin" if venv else "",
        )
        await self._set(active, AppRunStatus.STARTING)
        self._log(active, f"\n▸ Starting the app: {' '.join(stack.start)}\n")
        process = await self._spawn(active, argv)

        deadline = time.monotonic() + READY_TIMEOUT_S
        while not is_regular(ready):
            if process.returncode is not None:
                await self._drain(active)
                raise _Stop(
                    AppRunStatus.FAILED,
                    f"The app stopped while starting (exit code {process.returncode}). "
                    "The log shows why.",
                )
            if time.monotonic() > deadline:
                raise _Stop(
                    AppRunStatus.FAILED,
                    f"The app started but did not listen on port {APP_PORT} within "
                    f"{READY_TIMEOUT_S} seconds. It must listen on 127.0.0.1 and on the port "
                    "in the PORT environment variable.",
                )
            await asyncio.sleep(0.2)
        active.socket = socket_path
        await self._set(active, AppRunStatus.RUNNING, started=True)
        self._log(active, "▸ The app is running.\n")

        end = time.monotonic() + MAX_LIFETIME_S
        while True:
            try:
                code = await asyncio.wait_for(process.wait(), 30)
                break
            except TimeoutError:
                pass
            if time.monotonic() > end:
                raise _Stop(
                    AppRunStatus.STOPPED,
                    f"Stopped automatically after {MAX_LIFETIME_S // 60} minutes.",
                )
            used = await asyncio.to_thread(folder_bytes, work, (".venv", "node_modules"))
            if used > MAX_DATA_BYTES:
                raise _Stop(
                    AppRunStatus.STOPPED,
                    f"Stopped: the app's files grew beyond {MAX_DATA_BYTES // 1_000_000} MB.",
                )
        await self._drain(active)
        if code == 0:
            raise _Stop(AppRunStatus.STOPPED, "The app exited on its own.")
        raise _Stop(
            AppRunStatus.FAILED,
            (
                "The app was stopped by a sandbox limit (memory)."
                if code in (137, -9)
                else f"The app stopped with exit code {code}."
            )
            + " The log shows why.",
        )

    # ============================================================== processes

    async def _spawn(self, active: _Active, argv: list[str]) -> asyncio.subprocess.Process:
        process = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,
        )
        active.process = process
        active.reader = asyncio.create_task(self._read(active, process))
        return process

    async def _read(self, active: _Active, process: asyncio.subprocess.Process) -> None:
        assert process.stdout is not None
        with contextlib.suppress(OSError, ValueError):
            while chunk := await process.stdout.read(4096):
                self._log(active, chunk.decode(errors="replace"))

    async def _drain(self, active: _Active) -> None:
        """Waits (briefly) for the rest of a finished process's output."""
        if active.reader is not None:
            with contextlib.suppress(TimeoutError, asyncio.CancelledError):
                await asyncio.wait_for(asyncio.shield(active.reader), 5)

    async def _kill(self, active: _Active) -> None:
        process = active.process
        if process is not None and process.returncode is None:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(process.pid, signal.SIGKILL)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(process.wait(), 10)
        if active.reader is not None and not active.reader.done():
            with contextlib.suppress(TimeoutError, asyncio.CancelledError):
                await asyncio.wait_for(active.reader, 3)

    # =================================================================== state

    def _log(self, active: _Active, text: str) -> None:
        # Colour codes mean nothing in the page (and may arrive split across two reads).
        active.log = _ANSI.sub("", active.log + text)[-LOG_CHARS:]
        if active.flush is None:  # at most one save and one event per second
            loop = asyncio.get_running_loop()
            active.flush = loop.call_later(1.0, self._flush_soon, active)

    def _flush_soon(self, active: _Active) -> None:
        active.flush = None
        task = asyncio.create_task(self._save(active))
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def _save(self, active: _Active, **fields: Any) -> None:
        async with self.database.sessionmaker() as session:
            run = await session.get(AppRun, active.run_id)
            if run is None:
                return
            if run.status in APP_RUN_ACTIVE:  # a finished run's record is final
                run.status = active.status
                run.log = active.log
                for name, value in fields.items():
                    setattr(run, name, value)
                await session.commit()
            self.events.publish("app.run", run_out(run))

    async def _set(self, active: _Active, status: AppRunStatus, *, started: bool = False) -> None:
        active.status = status.value
        await self._save(active, **({"started_at": now()} if started else {}))

    async def _finish(self, active: _Active, status: AppRunStatus, error: str | None) -> None:
        await self._kill(active)
        active.socket = None
        if active.flush is not None:
            active.flush.cancel()
            active.flush = None
        for task in list(self._connections):
            task.cancel()
        if error:
            self._log(active, f"\n▸ {error}\n")
            if active.flush is not None:
                active.flush.cancel()
                active.flush = None
        active.status = status.value
        await self._save(active, error=error, finished_at=now())
        if self.active is active:
            self.active = None
        log.info("apps.run_finished", run_id=active.run_id, status=status.value)

    # ================================================================ network

    @contextlib.asynccontextmanager
    async def _proxy(self, active: _Active, ctl: Path) -> AsyncIterator[None]:
        """While an install runs: a proxy on a Unix socket that only the sandbox sees."""
        path = ctl / "proxy.sock"
        remove_path(path)

        async def client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            await self._tracked(self._proxy_client(active, reader, writer))

        server = await asyncio.start_unix_server(client, path=str(path))
        try:
            yield
        finally:
            server.close()
            remove_path(path)

    async def _tracked(self, work: Any) -> None:
        task = asyncio.current_task()
        assert task is not None
        self._connections.add(task)
        try:
            await work
        except (asyncio.CancelledError, OSError):
            pass
        finally:
            self._connections.discard(task)

    async def _proxy_client(
        self, active: _Active, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        async def refuse(status: str, why: str) -> None:
            body = why.encode()
            writer.write(
                f"HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {len(body)}\r\n"
                "Connection: close\r\n\r\n".encode()
                + body
            )
            with contextlib.suppress(OSError):
                await writer.drain()
            writer.close()

        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 15)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError):
            writer.close()
            return
        parts = head.split(b"\r\n", 1)[0].decode("latin-1").split()
        target = parts[1] if len(parts) == 3 else ""
        host, _, port = target.rpartition(":")
        host = host.strip("[]").lower()
        allowed = (
            len(parts) == 3
            and parts[0].upper() == "CONNECT"
            and port == "443"
            and host in self.registry_hosts
        )
        if not allowed:
            self._log(
                active,
                f"[blocked] The install tried to reach {target or 'another site'}; only "
                "the package registries are allowed.\n",
            )
            await refuse("403 Forbidden", "NEXUS: only the package registries can be reached.\n")
            return
        try:
            upstream = await asyncio.wait_for(
                asyncio.open_connection(*self.upstreams.get(host, (host, 443))), 20
            )
        except (OSError, TimeoutError) as error:
            self._log(active, f"[proxy] Could not connect to {host}: {error}\n")
            await refuse("502 Bad Gateway", f"NEXUS: could not connect to {host}.\n")
            return
        writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        await writer.drain()
        await _pipe(reader, writer, *upstream)

    async def _relay_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        await self._tracked(self._relay_to_app(reader, writer))

    async def _relay_to_app(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        active = self.active
        path = active.socket if active is not None else None
        upstream = None
        if path is not None and is_socket(path):  # a real socket, never a link to one
            with contextlib.suppress(OSError):
                upstream = await asyncio.open_unix_connection(str(path))
        if upstream is None:
            body = b"No app is running. Start one in NEXUS: Apps, then Run app.\n"
            writer.write(
                b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain; charset=utf-8\r\n"
                + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
                + body
            )
            with contextlib.suppress(OSError):
                await writer.drain()
            writer.close()
            return
        await _pipe(reader, writer, *upstream)
