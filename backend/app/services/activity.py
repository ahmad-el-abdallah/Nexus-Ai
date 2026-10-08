"""Employee status from what they are actually doing right now.

Chat replies and workflow steps call `begin()` / `end()`; the tracker derives the
one status the office shows (most recent activity wins):

  * an activity in progress     → its status ("working", "reviewing", …)
  * just finished / just failed → "completed" / "error" for a few seconds
  * tasks waiting in a running workflow → "assigned"
  * otherwise                   → "idle"

Suspended employees are never changed. Nothing here survives a restart (no work
is running after one), so `recover()` returns everyone to idle.

Each activity can also carry a *screen*: what the employee is working on and the
text they are producing as it streams in. The 3D office draws it on their desk
monitor — only real content, never invented.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, update

from app.core.events import EventBus
from app.core.logging import get_logger
from app.db.session import Database
from app.models import Employee, EmployeeStatus, Task, Workflow
from app.schemas import EmployeeOut, dump

log = get_logger("nexus.activity")

FLASH_SECONDS = {"completed": 8.0, "error": 30.0}
SCREEN_LINGER_SECONDS = 10.0  # a finished screen stays up briefly, marked done
SCREEN_PUBLISH_SECONDS = 0.25  # at most ~4 screen updates per second per employee
SCREEN_TEXT_CHARS = 2400
SCREEN_BRIEF_CHARS = 1200
WAITING_TASK = ("queued",)
LIVE_WORKFLOW = ("running",)


@dataclass
class Screen:
    """What is on an employee's monitor: real work only."""

    kind: str  # chat | plan | breakdown | work | review | summary | report
    title: str
    brief: str = ""  # what they were asked, or the work they are reviewing
    text: str = ""  # what they are producing, as it streams in
    thinking: bool = False  # a reasoning model is thinking (its reasoning isn't shown)
    done: bool = False
    failed: bool = False
    started_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def out(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "title": self.title[:200],
            "brief": self.brief[-SCREEN_BRIEF_CHARS:]
            if self.kind == "review"
            else self.brief[:SCREEN_BRIEF_CHARS],
            "text": self.text[-SCREEN_TEXT_CHARS:],
            "thinking": self.thinking,
            "done": self.done,
            "failed": self.failed,
            "started_at": self.started_at,
        }


@dataclass
class _Activity:
    status: str
    detail: str
    seq: int
    screen: Screen | None = None


class ActivityTracker:
    def __init__(self, database: Database, events: EventBus) -> None:
        self.database = database
        self.events = events
        self._active: dict[str, dict[int, _Activity]] = {}
        self._flash: dict[str, tuple[str, str, float]] = {}
        self._seq = 0
        self._lock = asyncio.Lock()
        self._timers: set[asyncio.Task[None]] = set()
        self._linger: dict[str, tuple[Screen, float]] = {}
        self._published: dict[str, float] = {}
        self._pending_screen: dict[str, asyncio.TimerHandle] = {}

    async def begin(
        self, employee_id: str, status: str, detail: str, screen: Screen | None = None
    ) -> int:
        self._seq += 1
        token = self._seq
        self._active.setdefault(employee_id, {})[token] = _Activity(status, detail, token, screen)
        self._flash.pop(employee_id, None)
        if screen is not None:
            self._linger.pop(employee_id, None)
            self._publish_screen(employee_id, force=True)
        await self.refresh(employee_id)
        return token

    # ----------------------------------------------------------------- screens

    def update_screen(
        self, employee_id: str, token: int, *, text: str | None = None, thinking: bool | None = None
    ) -> None:
        activity = self._active.get(employee_id, {}).get(token)
        if activity is None or activity.screen is None:
            return
        if text is not None:
            activity.screen.text = text
            activity.screen.thinking = False
        if thinking is not None:
            activity.screen.thinking = thinking
        self._publish_screen(employee_id)

    def screen_of(self, employee_id: str) -> Screen | None:
        activities = self._active.get(employee_id)
        if activities:
            latest = max(activities.values(), key=lambda a: a.seq)
            if latest.screen is not None:
                return latest.screen
            withscreen = [a for a in activities.values() if a.screen is not None]
            if withscreen:
                return max(withscreen, key=lambda a: a.seq).screen
        linger = self._linger.get(employee_id)
        if linger and linger[1] > time.monotonic():
            return linger[0]
        return None

    def screens(self) -> dict[str, dict[str, Any]]:
        ids = set(self._active) | set(self._linger)
        return {eid: s.out() for eid in ids if (s := self.screen_of(eid)) is not None}

    def _publish_screen(self, employee_id: str, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._published.get(employee_id, 0.0) < SCREEN_PUBLISH_SECONDS:
            # Throttled; make sure the latest text still goes out shortly.
            if employee_id not in self._pending_screen:
                self._pending_screen[employee_id] = asyncio.get_running_loop().call_later(
                    SCREEN_PUBLISH_SECONDS, self._flush_screen, employee_id
                )
            return
        self._published[employee_id] = now
        screen = self.screen_of(employee_id)
        self.events.publish(
            "employee.screen",
            {"employee_id": employee_id, "screen": screen.out() if screen else None},
        )

    def _flush_screen(self, employee_id: str) -> None:
        self._pending_screen.pop(employee_id, None)
        self._publish_screen(employee_id, force=True)

    async def end(
        self,
        employee_id: str,
        token: int,
        outcome: str | None = None,
        detail: str | None = None,
        *,
        screen_failed: bool = False,
    ) -> None:
        activities = self._active.get(employee_id, {})
        ended = activities.pop(token, None)
        if not activities:
            self._active.pop(employee_id, None)
        if ended is not None and ended.screen is not None:
            failed = screen_failed or outcome == "error"
            ended.screen.done = not failed
            ended.screen.failed = failed
            ended.screen.thinking = False
            self._linger[employee_id] = (ended.screen, time.monotonic() + SCREEN_LINGER_SECONDS)
            self._publish_screen(employee_id, force=True)
            timer = asyncio.create_task(self._expire_screen(employee_id, SCREEN_LINGER_SECONDS))
            self._timers.add(timer)
            timer.add_done_callback(self._timers.discard)
        if outcome in FLASH_SECONDS and detail:
            await self.flash(employee_id, outcome, detail)
        else:
            await self.refresh(employee_id)

    async def flash(self, employee_id: str, outcome: str, detail: str) -> None:
        """Briefly show "completed" / "error" (e.g. after a workflow task)."""
        if outcome not in FLASH_SECONDS:
            return
        self._flash[employee_id] = (outcome, detail, time.monotonic() + FLASH_SECONDS[outcome])
        timer = asyncio.create_task(self._expire(employee_id, FLASH_SECONDS[outcome]))
        self._timers.add(timer)
        timer.add_done_callback(self._timers.discard)
        await self.refresh(employee_id)

    async def _expire_screen(self, employee_id: str, seconds: float) -> None:
        await asyncio.sleep(seconds + 0.05)
        linger = self._linger.get(employee_id)
        if linger and linger[1] <= time.monotonic():
            self._linger.pop(employee_id, None)
            self._publish_screen(employee_id, force=True)

    async def _expire(self, employee_id: str, seconds: float) -> None:
        await asyncio.sleep(seconds + 0.05)
        await self.refresh(employee_id)

    def busy(self, employee_id: str) -> bool:
        return bool(self._active.get(employee_id))

    async def _desired(self, employee_id: str) -> tuple[str, str | None]:
        activities = self._active.get(employee_id)
        if activities:
            latest = max(activities.values(), key=lambda a: a.seq)
            return latest.status, latest.detail
        flash = self._flash.get(employee_id)
        if flash and flash[2] > time.monotonic():
            return flash[0], flash[1]
        self._flash.pop(employee_id, None)
        async with self.database.sessionmaker() as session:
            waiting = await session.scalar(
                select(func.count())
                .select_from(Task)
                .join(Workflow, Workflow.id == Task.workflow_id)
                .where(
                    Task.assignee_id == employee_id,
                    Task.status.in_(WAITING_TASK),
                    Task.kind == "work",
                    Workflow.status.in_(LIVE_WORKFLOW),
                )
            )
        if waiting:
            return EmployeeStatus.ASSIGNED.value, (
                f"{waiting} workflow task{'s' if waiting != 1 else ''} waiting"
            )
        return EmployeeStatus.IDLE.value, None

    async def refresh(self, employee_id: str) -> None:
        async with self._lock:
            status, detail = await self._desired(employee_id)
            async with self.database.sessionmaker() as session:
                employee = await session.get(Employee, employee_id)
                if employee is None or employee.status == EmployeeStatus.SUSPENDED:
                    return
                if employee.status == status and employee.status_detail == detail:
                    return
                employee.status, employee.status_detail = status, detail
                employee.status_changed_at = datetime.now(UTC)
                await session.commit()
                await session.refresh(employee)
                self.events.publish("employee.updated", dump(EmployeeOut.model_validate(employee)))

    async def refresh_many(self, employee_ids: set[str]) -> None:
        for employee_id in employee_ids:
            await self.refresh(employee_id)

    async def recover(self) -> int:
        """After a restart nothing is running: every non-suspended employee is idle."""
        async with self.database.sessionmaker() as session:
            result = await session.execute(
                update(Employee)
                .where(
                    Employee.status.not_in(
                        (EmployeeStatus.IDLE.value, EmployeeStatus.SUSPENDED.value)
                    )
                )
                .values(
                    status=EmployeeStatus.IDLE.value,
                    status_detail=None,
                    status_changed_at=datetime.now(UTC),
                )
            )
            await session.commit()
        count = result.rowcount  # type: ignore[attr-defined]
        if count:
            log.warning("activity.recovered", employees_reset=count)
        return count

    async def shutdown(self) -> None:
        for handle in self._pending_screen.values():
            handle.cancel()
        self._pending_screen.clear()
        timers = list(self._timers)
        for timer in timers:
            timer.cancel()
        if timers:
            await asyncio.wait(timers, timeout=5)
