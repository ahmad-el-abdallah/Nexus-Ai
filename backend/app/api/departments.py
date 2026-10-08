"""Departments: directory and owner configuration."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.ai import require_model
from app.db.session import get_session
from app.models import Department, Employee
from app.services.org import DepartmentChanges, OrgError, update_department

router = APIRouter(prefix="/api/departments", tags=["departments"])
Session = Annotated[AsyncSession, Depends(get_session)]


class DepartmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    key: str
    position: int
    name: str
    description: str
    responsibilities: list[str]
    roles: list[str]
    color: str
    room_id: str | None
    director_id: str | None
    model_id: str | None
    max_concurrent_tasks: int
    daily_request_budget: int
    headcount: int = 0


class DepartmentPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    description: str | None = Field(default=None, max_length=2000)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    room_id: str | None = None
    director_id: str | None = None
    model_id: str | None = None
    max_concurrent_tasks: int | None = Field(default=None, ge=1, le=20)
    daily_request_budget: int | None = Field(default=None, ge=0, le=100_000)


async def _headcounts(session: AsyncSession) -> dict[str, int]:
    rows = await session.execute(
        select(Employee.department, func.count()).group_by(Employee.department)
    )
    return {department: count for department, count in rows.all()}


def _out(department: Department, headcount: int) -> DepartmentOut:
    out = DepartmentOut.model_validate(department)
    out.headcount = headcount
    return out


@router.get("", response_model=list[DepartmentOut])
async def list_departments(session: Session) -> list[DepartmentOut]:
    counts = await _headcounts(session)
    departments = await session.scalars(select(Department).order_by(Department.position))
    return [_out(d, counts.get(d.key, 0)) for d in departments]


@router.get("/{key}", response_model=DepartmentOut)
async def get_department(key: str, session: Session) -> DepartmentOut:
    department = await session.get(Department, key)
    if department is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Department not found")
    return _out(department, (await _headcounts(session)).get(key, 0))


@router.patch("/{key}", response_model=DepartmentOut)
async def configure_department(key: str, patch: DepartmentPatch, session: Session) -> DepartmentOut:
    department = await session.get(Department, key)
    if department is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Department not found")
    fields = patch.model_fields_set
    if "model_id" in fields:
        await require_model(session, patch.model_id)
        department.model_id = patch.model_id
    changes = DepartmentChanges(
        name=patch.name,
        description=patch.description,
        color=patch.color,
        room_id=patch.room_id,
        director_id=patch.director_id,
        max_concurrent_tasks=patch.max_concurrent_tasks,
        daily_request_budget=patch.daily_request_budget,
        room_set="room_id" in fields,
        director_set="director_id" in fields,
    )
    try:
        department = await update_department(session, department, changes)
    except OrgError as error:
        await session.rollback()
        raise HTTPException(error.status, str(error)) from error
    return _out(department, (await _headcounts(session)).get(key, 0))
