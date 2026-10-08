"""Employee status from what they are actually doing right now.

Chat replies and workflow steps call `begin()` / `end()`; the tracker derives the
one status the office shows (most recent activity wins):

  * an activity in progress     → its status ("working", "reviewing", …)
  * just finished / just failed → "completed" / "error" for a few seconds
  * tasks waiting in a running workflow → "assigned"
  * otherwise                   → "idle"

Suspended employees are never changed. Nothing here survives a restart (no work
is running after one), so `recover()` returns everyone to idle.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import func, select, update

from app.core.events import EventBus
from app.core.logging import get_logger
from app.db.session import Database
from app.models import Employee, EmployeeStatus, Task, Workflow
from app.schemas import EmployeeOut, dump

log = get_logger("nexus.activity")

FLASH_SECONDS = {"completed": 8.0, "error": 30.0}
WAITING_TASK = ("queued",)
LIVE_WORKFLOW = ("running",)


@dataclass
class _Activity:
    status: str
    detail: str
    seq: int


class ActivityTracker:
    def __init__(self, database: Database, events: EventBus) -> None:
        self.database = database
        self.events = events
        self._active: dict[str, dict[int, _Activity]] = {}
        self._flash: dict[str, tuple[str, str, float]] = {}
        self._seq = 0
        self._lock = asyncio.Lock()
        self._timers: set[asyncio.Task[None]] = set()

    async def begin(self, employee_id: str, status: str, detail: str) -> int:
        self._seq += 1
        token = self._seq
        self._active.setdefault(employee_id, {})[token] = _Activity(status, detail, token)
        self._flash.pop(employee_id, None)
        await self.refresh(employee_id)
        return token

    async def end(
        self,
        employee_id: str,
        token: int,
        outcome: str | None = None,
        detail: str | None = None,
    ) -> None:
        activities = self._active.get(employee_id, {})
        activities.pop(token, None)
        if not activities:
            self._active.pop(employee_id, None)
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
        timers = list(self._timers)
        for timer in timers:
            timer.cancel()
        if timers:
            await asyncio.wait(timers, timeout=5)
