"""AI employee roster and owner-controlled availability."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.ai import require_model
from app.core.logging import get_logger
from app.db.session import get_session
from app.models import Employee, EmployeeStatus
from app.services.org import (
    EmployeeChanges,
    OrgError,
    create_employee,
    delete_employee,
    update_employee,
)

router = APIRouter(prefix="/api/employees", tags=["employees"])
log = get_logger("nexus.employees")

Session = Annotated[AsyncSession, Depends(get_session)]


class EmployeeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    role: str
    department: str
    seniority: str
    desk_id: str | None
    supervisor_id: str | None
    model_id: str | None
    avatar_seed: int
    status: EmployeeStatus
    status_detail: str | None
    status_changed_at: datetime


class EmployeeCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=2, max_length=80)
    department: str
    role: str
    seniority: str = "mid"
    desk_id: str | None = None
    supervisor_id: str | None = None


class EmployeePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=2, max_length=80)
    department: str | None = None
    role: str | None = None
    seniority: str | None = None
    desk_id: str | None = None
    supervisor_id: str | None = None
    model_id: str | None = None


def _org_error(error: OrgError) -> HTTPException:
    return HTTPException(error.status, str(error))


async def _get(session: AsyncSession, employee_id: str) -> Employee:
    employee = await session.get(Employee, employee_id)
    if employee is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Employee not found")
    return employee


async def _set_status(
    session: AsyncSession, employee: Employee, new: EmployeeStatus, detail: str | None
) -> Employee:
    previous = employee.status
    employee.status = new.value
    employee.status_detail = detail
    employee.status_changed_at = datetime.now(UTC)
    await session.commit()
    await session.refresh(employee)
    log.info(
        "employee.status_changed", employee_id=employee.id, previous=previous, status=new.value
    )
    return employee


@router.get("", response_model=list[EmployeeOut])
async def list_employees(session: Session) -> list[Employee]:
    result = await session.scalars(select(Employee).order_by(Employee.department, Employee.name))
    return list(result)


@router.post("", response_model=EmployeeOut, status_code=status.HTTP_201_CREATED)
async def hire_employee(body: EmployeeCreate, session: Session) -> Employee:
    """Owner action: add a new AI employee (a configuration — no model runs yet)."""
    try:
        return await create_employee(
            session,
            name=body.name,
            department_key=body.department,
            role=body.role,
            seniority=body.seniority,
            desk_id=body.desk_id,
            supervisor_id=body.supervisor_id,
        )
    except OrgError as error:
        await session.rollback()
        raise _org_error(error) from error


@router.patch("/{employee_id}", response_model=EmployeeOut)
async def edit_employee(employee_id: str, body: EmployeePatch, session: Session) -> Employee:
    """Owner action: rename, change role, move department, re-seat or re-report."""
    employee = await _get(session, employee_id)
    fields = body.model_fields_set
    if "model_id" in fields:
        await require_model(session, body.model_id)
        employee.model_id = body.model_id
    changes = EmployeeChanges(
        name=body.name,
        role=body.role,
        department=body.department,
        seniority=body.seniority,
        desk_id=body.desk_id,
        supervisor_id=body.supervisor_id,
        desk_set="desk_id" in fields,
        supervisor_set="supervisor_id" in fields,
    )
    try:
        return await update_employee(session, employee, changes)
    except OrgError as error:
        await session.rollback()
        raise _org_error(error) from error


@router.delete("/{employee_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_employee(employee_id: str, session: Session) -> None:
    """Owner action: remove an employee. Their reports move up to their manager."""
    employee = await _get(session, employee_id)
    try:
        await delete_employee(session, employee)
    except OrgError as error:
        await session.rollback()
        raise _org_error(error) from error


@router.get("/{employee_id}", response_model=EmployeeOut)
async def get_employee(employee_id: str, session: Session) -> Employee:
    return await _get(session, employee_id)


@router.post("/{employee_id}/suspend", response_model=EmployeeOut)
async def suspend_employee(employee_id: str, session: Session) -> Employee:
    """Owner action: take an employee out of service (reversible)."""
    employee = await _get(session, employee_id)
    if employee.status == EmployeeStatus.SUSPENDED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Employee is already suspended")
    return await _set_status(session, employee, EmployeeStatus.SUSPENDED, "Suspended by the owner")


@router.post("/{employee_id}/activate", response_model=EmployeeOut)
async def activate_employee(employee_id: str, session: Session) -> Employee:
    """Owner action: return a suspended employee to service as idle."""
    employee = await _get(session, employee_id)
    if employee.status != EmployeeStatus.SUSPENDED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Only suspended employees can be activated")
    return await _set_status(session, employee, EmployeeStatus.IDLE, None)
