"""What an employee knows about the company: a live briefing from the database.

Like in a real company, access follows position:
- everyone: the company directory (departments, directors, headcount), their manager,
  their own team (who does what, who is busy, on what) and their own tasks;
- department directors: also their team's workload and track record, and the
  workflows their department is part of;
- executive management: every department in that detail, all running and recent
  workflows, and the email approval queue (counts only).

Everything comes from stored records at the moment of the request; nothing is
summarised by a model or invented. Records NEXUS doesn't keep yet (performance
ratings, salaries, …) are named so agents say so instead of guessing.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    TERMINAL,
    Department,
    EmailAccount,
    EmailMessage,
    EmailStatus,
    Employee,
    Task,
    TaskStatus,
    Workflow,
)
from app.models.workflow import FINISHED

MAX_CHARS = 14_000
ACTIVE_TASK_LIMIT = 3
RECENT_WORKFLOWS = 5
STATUS_TEXT = {
    "idle": "available",
    "assigned": "has tasks waiting",
    "working": "working",
    "researching": "researching",
    "meeting": "in a meeting",
    "reviewing": "reviewing work",
    "blocked": "blocked",
    "completed": "just finished a task",
    "error": "a task just failed",
    "suspended": "suspended (not working)",
}
NOT_RECORDED = (
    "NEXUS does not record performance ratings or reviews yet (they arrive with employee "
    "profiles), nor salaries, holidays, private details or customer data."
)


@dataclass
class _Facts:
    departments: list[Department]
    by_key: dict[str, Department]
    people: list[Employee]
    by_id: dict[str, Employee]
    active: dict[str, list[Task]]  # assignee → unfinished tasks
    done: Counter[str]
    failed: Counter[str]
    open_by_department: Counter[str]


def _count(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def level_of(employee: Employee, departments: list[Department]) -> str:
    if employee.department == "executive":
        return "executive"
    if any(d.director_id == employee.id for d in departments) or employee.seniority in (
        "director",
        "executive",
    ):
        return "director"
    return "staff"


def _where(employee: Employee) -> str:
    if not employee.desk_id:
        return "remote (no desk in the building)"
    room, _, number = employee.desk_id.rpartition("-desk-")
    return f"desk {number} in the {room.replace('-', ' ')} area" if number else employee.desk_id


def _person(employee: Employee, facts: _Facts, *, detail: bool) -> str:
    parts = [f"{employee.name} — {employee.role} ({employee.seniority})"]
    if employee.gender:
        parts.append(employee.gender)
    state = STATUS_TEXT.get(employee.status, employee.status)
    if employee.status_detail and employee.status != "idle":
        state += f": {employee.status_detail}"
    parts.append(state)
    parts.append(_where(employee))
    manager = facts.by_id.get(employee.supervisor_id or "")
    if manager:
        parts.append(f"reports to {manager.name}")
    tasks = facts.active.get(employee.id, [])
    if tasks:
        titles = "; ".join(
            f"“{t.title}” ({t.status.replace('_', ' ')})" for t in tasks[:ACTIVE_TASK_LIMIT]
        )
        more = f" +{len(tasks) - ACTIVE_TASK_LIMIT} more" if len(tasks) > ACTIVE_TASK_LIMIT else ""
        parts.append(f"current tasks: {titles}{more}")
    else:
        parts.append("no current tasks")
    if detail:
        parts.append(
            f"record: {facts.done[employee.id]} task(s) completed, "
            f"{facts.failed[employee.id]} failed"
        )
    return "- " + " · ".join(parts)


def _department_line(d: Department, facts: _Facts) -> str:
    members = [p for p in facts.people if p.department == d.key]
    director = facts.by_id.get(d.director_id or "")
    busy = sum(p.status not in ("idle", "suspended") for p in members)
    suspended = sum(p.status == "suspended" for p in members)
    remote = sum(not p.desk_id for p in members)
    return (
        f"- {d.name} (key: {d.key}) — director: {director.name if director else 'none appointed'}; "
        f"{_count(len(members), 'person', 'people')} ({remote} remote), {busy} busy, {suspended} suspended; "
        f"{facts.open_by_department[d.key]} unfinished task(s)"
    )


def _team(d: Department, facts: _Facts, *, detail: bool) -> list[str]:
    members = sorted(
        (p for p in facts.people if p.department == d.key),
        key=lambda p: (p.id != d.director_id, p.name),
    )
    lines = [f"{d.name} — {_count(len(members), 'person', 'people')}. Mission: {d.description}"]
    lines += [_person(p, facts, detail=detail) for p in members] or ["- nobody yet"]
    return lines


async def _facts(session: AsyncSession) -> _Facts:
    departments = list(await session.scalars(select(Department).order_by(Department.position)))
    people = list(await session.scalars(select(Employee).order_by(Employee.name)))
    active: dict[str, list[Task]] = defaultdict(list)
    open_by_department: Counter[str] = Counter()
    unfinished = [s.value for s in TaskStatus if s not in TERMINAL and s != TaskStatus.PROPOSED]
    for task in await session.scalars(
        select(Task).where(Task.status.in_(unfinished)).order_by(Task.created_at)
    ):
        open_by_department[task.department] += 1
        if task.assignee_id:
            active[task.assignee_id].append(task)
    done: Counter[str] = Counter()
    failed: Counter[str] = Counter()
    for assignee, status, count in await session.execute(
        select(Task.assignee_id, Task.status, func.count())
        .where(Task.assignee_id.is_not(None), Task.status.in_(["done", "failed"]))
        .group_by(Task.assignee_id, Task.status)
    ):
        (done if status == "done" else failed)[assignee] = count
    return _Facts(
        departments,
        {d.key: d for d in departments},
        people,
        {p.id: p for p in people},
        active,
        done,
        failed,
        open_by_department,
    )


async def _workflows(session: AsyncSession, department: str | None) -> list[str]:
    rows = list(
        await session.scalars(select(Workflow).order_by(Workflow.created_at.desc()).limit(40))
    )
    running, finished = [], []
    for w in rows:
        tasks = list(
            await session.scalars(
                select(Task).where(Task.workflow_id == w.id, Task.kind == "assignment")
            )
        )
        departments = sorted({t.department for t in tasks})
        if department and department not in departments:
            continue
        done = sum(t.status == TaskStatus.DONE for t in tasks)
        line = (
            f"- “{w.title}” — {w.status.replace('_', ' ')}; departments: "
            f"{', '.join(departments) or 'not planned yet'}; {done}/{len(tasks)} done; "
            f"started {w.created_at:%Y-%m-%d}"
        )
        if w.status in FINISHED:
            if len(finished) < RECENT_WORKFLOWS:
                finished.append(
                    line + (f"; finished {w.finished_at:%Y-%m-%d}" if w.finished_at else "")
                )
        else:
            running.append(line)
    lines = ["In progress:", *(running or ["- none"])]
    lines += ["Recently finished:", *(finished or ["- none"])]
    return lines


async def company_briefing(session: AsyncSession, employee: Employee) -> str:
    facts = await _facts(session)
    level = level_of(employee, facts.departments)
    own = facts.by_key.get(employee.department)
    manager = facts.by_id.get(employee.supervisor_id or "")
    reports = [p for p in facts.people if p.supervisor_id == employee.id]
    access = {
        "executive": "executive management — the whole company",
        "director": f"director — your department ({own.name if own else employee.department}) in full, plus the company directory",
        "staff": "staff — your team and the company directory",
    }[level]
    now = datetime.now(UTC)
    lines = [
        "COMPANY DATA — live from the NEXUS AI records at "
        f"{now:%Y-%m-%d %H:%M} UTC. Your access level: {access}.",
        "This is real, current information. Use it to answer the owner's questions about "
        "people, teams and work, with names and numbers. Do not say you lack access to "
        "anything listed here, and do not invent anything that isn't. " + NOT_RECORDED,
        "",
        f"YOU: {employee.name}, {employee.role} in {own.name if own else employee.department}"
        + (
            f"; you report to {manager.name} ({manager.role})"
            if manager
            else "; you report to the owner"
        )
        + (f"; your direct reports: {', '.join(p.name for p in reports)}" if reports else ""),
    ]
    mine = facts.active.get(employee.id, [])
    lines.append(
        "Your current tasks: "
        + ("; ".join(f"“{t.title}” ({t.status.replace('_', ' ')})" for t in mine) or "none")
    )
    lines.append(
        "Only these recorded tasks are real work. Never say that you or a colleague are "
        "working on, have built, or will deliver something that isn't recorded here — "
        "ideas discussed in a chat are not work in progress until the owner makes them a task."
    )
    lines += [
        "",
        f"COMPANY DIRECTORY ({len(facts.departments)} departments, {len(facts.people)} employees):",
    ]
    lines += [_department_line(d, facts) for d in facts.departments]

    if level == "executive":
        lines += ["", "ALL TEAMS:"]
        for d in facts.departments:
            lines += _team(d, facts, detail=True)
        lines += [
            "",
            "WORKFLOWS (objectives the owner gave the CEO):",
            *await _workflows(session, None),
        ]
        waiting = await session.scalar(
            select(func.count())
            .select_from(EmailMessage)
            .where(EmailMessage.status == EmailStatus.PENDING_APPROVAL)
        )
        accounts = await session.scalar(
            select(func.count()).select_from(EmailAccount).where(EmailAccount.status == "connected")
        )
        lines += [
            "",
            f"EMAIL: {accounts or 0} connected account(s); {waiting or 0} draft(s) waiting for "
            "the owner's approval.",
        ]
    elif own is not None:
        lines += ["", "YOUR TEAM:", *_team(own, facts, detail=level == "director")]
        if level == "director":
            lines += [
                "",
                f"WORKFLOWS INVOLVING {own.name.upper()}:",
                *await _workflows(session, own.key),
            ]

    text = "\n".join(lines)
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS].rsplit("\n", 1)[0] + "\n[…company data shortened]"
    return text
