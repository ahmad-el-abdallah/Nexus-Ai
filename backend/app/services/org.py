"""Organisation rules, enforced server-side for every change.

* Roles must belong to the employee's department.
* Desks must exist in the building and be free.
* Reporting lines form a tree under the CEO (no cycles, the CEO reports to no one).
* A department's director must be one of its own members.
"""

from __future__ import annotations

import random
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.core.office import desk_ids, office_room_ids
from app.models import Department, Employee

log = get_logger("nexus.org")

SENIORITY_LEVELS = ("executive", "director", "senior", "mid", "junior")
CEO_DEPARTMENT = "executive"


class OrgError(Exception):
    """A change that breaks an organisation rule (HTTP 422 / 409)."""

    def __init__(self, message: str, status: int = 422) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class EmployeeChanges:
    name: str | None = None
    role: str | None = None
    department: str | None = None
    seniority: str | None = None
    desk_id: str | None = None
    supervisor_id: str | None = None
    # Distinguish "not provided" from an explicit null.
    desk_set: bool = False
    supervisor_set: bool = False


async def department_or_error(session: AsyncSession, key: str) -> Department:
    department = await session.get(Department, key)
    if department is None:
        raise OrgError(f"Unknown department '{key}'")
    return department


async def ceo_id(session: AsyncSession) -> str | None:
    executive = await session.get(Department, CEO_DEPARTMENT)
    return executive.director_id if executive else None


def _clean_name(name: str) -> str:
    cleaned = " ".join(name.split())
    if not 2 <= len(cleaned) <= 80:
        raise OrgError("Name must be between 2 and 80 characters")
    return cleaned


async def _check_desk(session: AsyncSession, desk_id: str | None, employee_id: str | None) -> None:
    if desk_id is None:
        return
    if desk_id not in desk_ids():
        raise OrgError(f"Desk '{desk_id}' does not exist in the building")
    holder = await session.scalar(select(Employee.id).where(Employee.desk_id == desk_id))
    if holder is not None and holder != employee_id:
        raise OrgError(f"Desk '{desk_id}' is already taken", status=409)


async def _check_supervisor(
    session: AsyncSession, employee_id: str | None, supervisor_id: str | None
) -> None:
    ceo = await ceo_id(session)
    if employee_id is not None and employee_id == ceo:
        if supervisor_id is not None:
            raise OrgError("The CEO is at the top of the organisation and reports to no one")
        return
    if supervisor_id is None:
        raise OrgError("Every employee except the CEO needs a supervisor")
    if supervisor_id == employee_id:
        raise OrgError("An employee cannot supervise themselves")
    # Walk up the chain: reaching the employee again would create a cycle.
    seen: set[str] = set()
    current: str | None = supervisor_id
    while current is not None:
        if current == employee_id:
            raise OrgError("That reporting line would create a cycle")
        if current in seen:
            break
        seen.add(current)
        boss = await session.get(Employee, current)
        if boss is None:
            raise OrgError(f"Unknown supervisor '{current}'")
        current = boss.supervisor_id


async def _default_supervisor(
    session: AsyncSession, department: Department, employee_id: str | None
) -> str | None:
    if department.director_id and department.director_id != employee_id:
        return department.director_id
    return await ceo_id(session)


async def create_employee(
    session: AsyncSession,
    *,
    name: str,
    department_key: str,
    role: str,
    seniority: str,
    desk_id: str | None,
    supervisor_id: str | None,
) -> Employee:
    department = await department_or_error(session, department_key)
    if role not in department.roles:
        raise OrgError(f"'{role}' is not a role in {department.name}")
    if seniority not in SENIORITY_LEVELS:
        raise OrgError(f"Seniority must be one of: {', '.join(SENIORITY_LEVELS)}")
    await _check_desk(session, desk_id, None)
    supervisor = supervisor_id or await _default_supervisor(session, department, None)
    await _check_supervisor(session, None, supervisor)
    employee = Employee(
        id=f"emp_{uuid.uuid4().hex[:12]}",
        name=_clean_name(name),
        role=role,
        department=department.key,
        seniority=seniority,
        desk_id=desk_id,
        supervisor_id=supervisor,
        avatar_seed=random.randint(1, 1_000_000),  # noqa: S311 - cosmetic seed, not security
        status="idle",
    )
    session.add(employee)
    await session.commit()
    await session.refresh(employee)
    log.info("employee.created", employee_id=employee.id, department=department.key, role=role)
    return employee


async def update_employee(
    session: AsyncSession, employee: Employee, changes: EmployeeChanges
) -> Employee:
    old_department = await department_or_error(session, employee.department)
    department = old_department
    if changes.department is not None and changes.department != employee.department:
        department = await department_or_error(session, changes.department)
        if employee.id == await ceo_id(session):
            raise OrgError("The CEO cannot leave Executive Management; appoint a new CEO first")
    role = changes.role if changes.role is not None else employee.role
    if role not in department.roles:
        raise OrgError(f"'{role}' is not a role in {department.name}; choose one of its roles")
    if changes.seniority is not None and changes.seniority not in SENIORITY_LEVELS:
        raise OrgError(f"Seniority must be one of: {', '.join(SENIORITY_LEVELS)}")
    if changes.desk_set:
        await _check_desk(session, changes.desk_id, employee.id)

    moving = department.key != old_department.key
    if changes.supervisor_set:
        supervisor = changes.supervisor_id
    elif moving:
        supervisor = await _default_supervisor(session, department, employee.id)
    else:
        supervisor = employee.supervisor_id
    await _check_supervisor(session, employee.id, supervisor)

    if moving and old_department.director_id == employee.id:
        # Leaving a department you direct: it has no director until one is appointed.
        old_department.director_id = None
        await _reattach_reports(session, employee.id, await ceo_id(session))

    if changes.name is not None:
        employee.name = _clean_name(changes.name)
    employee.role = role
    employee.department = department.key
    if changes.seniority is not None:
        employee.seniority = changes.seniority
    if changes.desk_set:
        employee.desk_id = changes.desk_id
    employee.supervisor_id = supervisor
    await session.commit()
    await session.refresh(employee)
    log.info("employee.updated", employee_id=employee.id, department=department.key, moved=moving)
    return employee


async def _reattach_reports(
    session: AsyncSession, manager_id: str, new_manager: str | None
) -> None:
    reports = await session.scalars(select(Employee).where(Employee.supervisor_id == manager_id))
    for report in reports:
        report.supervisor_id = new_manager


async def delete_employee(session: AsyncSession, employee: Employee) -> None:
    if employee.id == await ceo_id(session):
        raise OrgError("The CEO cannot be removed; appoint a new CEO first", status=409)
    # Reports move up to this employee's manager; a directed department loses its director.
    await _reattach_reports(session, employee.id, employee.supervisor_id)
    directed = await session.scalars(
        select(Department).where(Department.director_id == employee.id)
    )
    for department in directed:
        department.director_id = None
    await session.delete(employee)
    await session.commit()
    log.info("employee.deleted", employee_id=employee.id)


@dataclass
class DepartmentChanges:
    name: str | None = None
    description: str | None = None
    color: str | None = None
    room_id: str | None = None
    director_id: str | None = None
    max_concurrent_tasks: int | None = None
    daily_request_budget: int | None = None
    room_set: bool = False
    director_set: bool = False


async def update_department(
    session: AsyncSession, department: Department, changes: DepartmentChanges
) -> Department:
    if changes.name is not None:
        name = " ".join(changes.name.split())
        if not 2 <= len(name) <= 80:
            raise OrgError("Department name must be between 2 and 80 characters")
        department.name = name
    if changes.description is not None:
        department.description = changes.description.strip()[:2000]
    if changes.color is not None:
        department.color = changes.color
    if changes.room_set:
        if changes.room_id is not None and changes.room_id not in office_room_ids():
            raise OrgError(f"'{changes.room_id}' is not an office room in the building")
        department.room_id = changes.room_id
    if changes.max_concurrent_tasks is not None:
        department.max_concurrent_tasks = changes.max_concurrent_tasks
    if changes.daily_request_budget is not None:
        department.daily_request_budget = changes.daily_request_budget
    if changes.director_set and changes.director_id != department.director_id:
        await _appoint_director(session, department, changes.director_id)
    await session.commit()
    await session.refresh(department)
    log.info("department.updated", department=department.key)
    return department


async def _appoint_director(
    session: AsyncSession, department: Department, director_id: str | None
) -> None:
    previous = department.director_id
    if director_id is None:
        if department.key == CEO_DEPARTMENT:
            raise OrgError("Executive Management must always have a CEO")
        department.director_id = None
        return
    director = await session.get(Employee, director_id)
    if director is None or director.department != department.key:
        raise OrgError("A director must be a member of the department")
    department.director_id = director_id
    # Whoever reported to the previous director now reports to the new one,
    # and the previous director (if still here) reports to the new one too.
    if previous:
        await _reattach_reports(session, previous, director_id)
        old = await session.get(Employee, previous)
        if old and (old.department == department.key or department.key == CEO_DEPARTMENT):
            old.supervisor_id = director_id
    # Directors report to the CEO; the CEO reports to no one.
    director.supervisor_id = None if department.key == CEO_DEPARTMENT else await ceo_id(session)
