"""Department task records. Stage 6 records tasks (e.g. from chat); nothing
executes them until the orchestration engine arrives in Stage 8."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.db.session import get_session
from app.models import Conversation, Department, Employee, Message, Task, TaskStatus
from app.schemas import TaskOut, dump
from app.services.chat import new_id

router = APIRouter(prefix="/api/tasks", tags=["tasks"])
log = get_logger("nexus.tasks")
Session = Annotated[AsyncSession, Depends(get_session)]


class TaskCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=3, max_length=160)
    description: str = Field(default="", max_length=20_000)
    department: str
    assignee_id: str | None = None
    source_conversation_id: str | None = None
    source_message_id: int | None = None


class TaskPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=3, max_length=160)
    description: str | None = Field(default=None, max_length=20_000)
    assignee_id: str | None = None
    status: TaskStatus | None = None


async def _check_assignee(session: AsyncSession, department: str, assignee_id: str | None) -> None:
    if assignee_id is None:
        return
    employee = await session.get(Employee, assignee_id)
    if employee is None:
        raise HTTPException(404, "Assignee not found")
    if employee.department != department:
        raise HTTPException(422, f"{employee.name} isn't in this department.")


def _publish(request: Request, kind: str, task: Task) -> TaskOut:
    out = TaskOut.model_validate(task)
    request.app.state.events.publish(kind, dump(out))
    return out


@router.get("", response_model=list[TaskOut])
async def list_tasks(
    session: Session,
    department: str | None = None,
    status: TaskStatus | None = None,
    conversation_id: str | None = None,
) -> list[Task]:
    query = select(Task)
    if department:
        query = query.where(Task.department == department)
    if status:
        query = query.where(Task.status == status.value)
    if conversation_id:
        query = query.where(Task.source_conversation_id == conversation_id)
    return list(await session.scalars(query.order_by(Task.created_at.desc(), Task.id)))


@router.post("", response_model=TaskOut, status_code=201)
async def create_task(body: TaskCreate, session: Session, request: Request) -> TaskOut:
    if await session.get(Department, body.department) is None:
        raise HTTPException(404, "Department not found")
    await _check_assignee(session, body.department, body.assignee_id)
    if body.source_message_id is not None:
        message = await session.get(Message, body.source_message_id)
        if message is None or message.conversation_id != body.source_conversation_id:
            raise HTTPException(422, "The source message isn't part of that conversation.")
    elif body.source_conversation_id is not None:
        if await session.get(Conversation, body.source_conversation_id) is None:
            raise HTTPException(404, "Conversation not found")
    task = Task(
        id=new_id("tsk"),
        title=body.title.strip(),
        description=body.description.strip(),
        department=body.department,
        assignee_id=body.assignee_id,
        status=TaskStatus.OPEN.value,
        source_conversation_id=body.source_conversation_id,
        source_message_id=body.source_message_id,
    )
    session.add(task)
    await session.commit()
    await session.refresh(task)
    log.info("task.created", task_id=task.id, department=task.department)
    return _publish(request, "task.updated", task)


@router.patch("/{task_id}", response_model=TaskOut)
async def update_task(task_id: str, body: TaskPatch, session: Session, request: Request) -> TaskOut:
    task = await session.get(Task, task_id)
    if task is None:
        raise HTTPException(404, "Task not found")
    fields = body.model_fields_set
    if "assignee_id" in fields:
        await _check_assignee(session, task.department, body.assignee_id)
        task.assignee_id = body.assignee_id
    if body.title is not None:
        task.title = body.title.strip()
    if body.description is not None:
        task.description = body.description.strip()
    if body.status is not None:
        task.status = body.status.value
    await session.commit()
    await session.refresh(task)
    return _publish(request, "task.updated", task)
