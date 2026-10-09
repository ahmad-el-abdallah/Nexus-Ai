"""Builds an employee's profile from the real record.

Everything about performance is computed here from verified activity — recorded
tasks, sandbox runs and supervisor reviews — so a score can never be invented or
drift from what actually happened. The stored tables hold only what the owner typed
(skills, ratings, notes) and an audit trail of changes. When there is no evidence,
the number is reported as None and the UI shows "Not enough data".
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    CodeRun,
    Department,
    Employee,
    EmployeeEvent,
    EmployeeFeedback,
    RunStatus,
    Task,
    TaskStatus,
)

# Tasks an employee personally works on (not the supervisor-level "assignment" rows).
WORK_KINDS = ("manual", "work")
ACTIVE_STATUSES = (
    TaskStatus.OPEN.value,
    TaskStatus.QUEUED.value,
    TaskStatus.RUNNING.value,
    TaskStatus.AWAITING_REVIEW.value,
    TaskStatus.REVIEWING.value,
)
HISTORY_LIMIT = 20
RUN_OK = (RunStatus.SUCCEEDED.value,)
RUN_BAD = (
    RunStatus.FAILED.value,
    RunStatus.TIMED_OUT.value,
    RunStatus.KILLED.value,
    RunStatus.ERROR.value,
)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _task_brief(t: Task) -> dict[str, Any]:
    return {
        "id": t.id,
        "title": t.title,
        "status": t.status,
        "kind": t.kind,
        "workflow_id": t.workflow_id,
        "revisions": t.revisions,
        "created_at": _iso(t.created_at),
        "finished_at": _iso(t.finished_at),
        "has_result": bool(t.result),
    }


async def _performance(session: AsyncSession, employee_id: str) -> dict[str, Any]:
    done = failed = revisions = 0
    for status, count, revs in await session.execute(
        select(Task.status, func.count(), func.coalesce(func.sum(Task.revisions), 0))
        .where(Task.assignee_id == employee_id, Task.kind.in_(WORK_KINDS))
        .group_by(Task.status)
    ):
        if status == TaskStatus.DONE.value:
            done += count
        elif status == TaskStatus.FAILED.value:
            failed += count
        revisions += int(revs)

    runs_ok = runs_bad = 0
    for status, count in await session.execute(
        select(CodeRun.status, func.count())
        .where(CodeRun.employee_id == employee_id)
        .group_by(CodeRun.status)
    ):
        if status in RUN_OK:
            runs_ok += count
        elif status in RUN_BAD:
            runs_bad += count

    finished = done + failed + runs_ok + runs_bad
    succeeded = done + runs_ok
    # A single evidence-based success rate across finished tasks and runs; None if no evidence.
    success_rate = round(100 * succeeded / finished) if finished else None
    return {
        "tasks_done": done,
        "tasks_failed": failed,
        "revisions_requested": revisions,
        "runs_succeeded": runs_ok,
        "runs_failed": runs_bad,
        "finished_items": finished,
        "success_rate": success_rate,
        "basis": f"{succeeded} of {finished} finished tasks and sandbox runs succeeded"
        if finished
        else "No finished tasks or runs yet",
    }


async def _ratings(session: AsyncSession, employee_id: str) -> dict[str, Any]:
    avg, count = (
        await session.execute(
            select(func.avg(EmployeeFeedback.rating), func.count(EmployeeFeedback.rating)).where(
                EmployeeFeedback.employee_id == employee_id, EmployeeFeedback.rating.is_not(None)
            )
        )
    ).one()
    return {
        "average": round(float(avg), 1) if avg is not None else None,
        "count": int(count or 0),
    }


async def build_profile(session: AsyncSession, employee: Employee) -> dict[str, Any]:
    department = await session.get(Department, employee.department)
    manager = (
        await session.get(Employee, employee.supervisor_id) if employee.supervisor_id else None
    )
    reports = list(
        await session.scalars(
            select(Employee).where(Employee.supervisor_id == employee.id).order_by(Employee.name)
        )
    )
    active = list(
        await session.scalars(
            select(Task)
            .where(
                Task.assignee_id == employee.id,
                Task.kind.in_(WORK_KINDS),
                Task.status.in_(ACTIVE_STATUSES),
            )
            .order_by(Task.created_at.desc())
        )
    )
    history = list(
        await session.scalars(
            select(Task)
            .where(
                Task.assignee_id == employee.id,
                Task.kind.in_(WORK_KINDS),
                Task.status.in_([TaskStatus.DONE.value, TaskStatus.FAILED.value]),
            )
            .order_by(Task.finished_at.desc().nulls_last(), Task.created_at.desc())
            .limit(HISTORY_LIMIT)
        )
    )
    runs = list(
        await session.scalars(
            select(CodeRun)
            .where(CodeRun.employee_id == employee.id)
            .order_by(CodeRun.created_at.desc())
            .limit(HISTORY_LIMIT)
        )
    )
    feedback = list(
        await session.scalars(
            select(EmployeeFeedback)
            .where(EmployeeFeedback.employee_id == employee.id)
            .order_by(EmployeeFeedback.id.desc())
        )
    )
    changes = list(
        await session.scalars(
            select(EmployeeEvent)
            .where(EmployeeEvent.employee_id == employee.id)
            .order_by(EmployeeEvent.id.desc())
            .limit(HISTORY_LIMIT)
        )
    )

    return {
        "id": employee.id,
        "name": employee.name,
        "role": employee.role,
        "department": employee.department,
        "department_name": department.name if department else employee.department,
        "seniority": employee.seniority,
        "gender": employee.gender,
        "desk_id": employee.desk_id,
        "avatar_seed": employee.avatar_seed,
        "status": employee.status,
        "status_detail": employee.status_detail,
        "status_changed_at": _iso(employee.status_changed_at),
        "model_id": employee.model_id,
        "manager": {"id": manager.id, "name": manager.name, "role": manager.role}
        if manager
        else None,
        "reports": [{"id": r.id, "name": r.name, "role": r.role} for r in reports],
        "skills": list(employee.skills or []),
        "performance": await _performance(session, employee.id),
        "rating": await _ratings(session, employee.id),
        "active_assignments": [_task_brief(t) for t in active],
        "task_history": [_task_brief(t) for t in history],
        "runs": [
            {
                "id": r.id,
                "language": r.language,
                "status": r.status,
                "created_at": _iso(r.created_at),
                "files": len(r.files),
            }
            for r in runs
        ],
        "feedback": [
            {
                "id": f.id,
                "rating": f.rating,
                "note": f.note,
                "created_at": _iso(f.created_at),
            }
            for f in feedback
        ],
        "history": [
            {
                "id": e.id,
                "kind": e.kind,
                "text": e.text,
                "created_at": _iso(e.created_at),
            }
            for e in changes
        ],
        "generated_at": datetime.now(UTC).isoformat(),
    }


def log_event(
    session: AsyncSession,
    employee_id: str,
    kind: str,
    text: str,
    from_value: str | None = None,
    to_value: str | None = None,
) -> None:
    """Records one history entry (the caller commits)."""
    session.add(
        EmployeeEvent(
            employee_id=employee_id,
            kind=kind,
            text=text,
            from_value=from_value,
            to_value=to_value,
        )
    )
