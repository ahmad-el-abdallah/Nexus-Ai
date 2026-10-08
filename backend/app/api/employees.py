"""AI employee roster and owner-controlled availability."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.db.session import get_session
from app.models import Employee, EmployeeStatus

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
    avatar_seed: int
    status: EmployeeStatus
    status_detail: str | None
    status_changed_at: datetime


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
