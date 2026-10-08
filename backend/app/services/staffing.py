"""Who can work for a department right now (shared by chat routing and workflows)."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Department, Employee, EmployeeStatus
from app.services.org import CEO_DEPARTMENT, SENIORITY_LEVELS

SENIORITY_RANK = {level: rank for rank, level in enumerate(SENIORITY_LEVELS)}


async def available_members(session: AsyncSession, department_key: str) -> list[Employee]:
    """Members who are not suspended, most senior first."""
    members = list(
        await session.scalars(
            select(Employee).where(
                Employee.department == department_key,
                Employee.status != EmployeeStatus.SUSPENDED.value,
            )
        )
    )
    return sorted(members, key=lambda m: (SENIORITY_RANK.get(m.seniority, 99), m.name))


def lead_of(department: Department, members: list[Employee]) -> Employee | None:
    """The director if available, otherwise the most senior available member."""
    director = next((m for m in members if m.id == department.director_id), None)
    return director or (members[0] if members else None)


async def department_lead(session: AsyncSession, department_key: str) -> Employee | None:
    department = await session.get(Department, department_key)
    if department is None:
        return None
    return lead_of(department, await available_members(session, department_key))


async def available_ceo(session: AsyncSession) -> Employee | None:
    """The CEO (executive director) — only if not suspended; nobody stands in for them."""
    executive = await session.get(Department, CEO_DEPARTMENT)
    if executive is None or executive.director_id is None:
        return None
    ceo = await session.get(Employee, executive.director_id)
    return ceo if ceo and ceo.status != EmployeeStatus.SUSPENDED else None
