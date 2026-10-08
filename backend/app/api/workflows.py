"""Workflows: the owner gives the CEO an objective; departments carry it out."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.models import Conversation, Message, MessageRole, Task, TaskStatus, Workflow, WorkflowEvent
from app.orchestration.engine import (
    DEFAULT_MAX_CALLS,
    Orchestrator,
    WorkflowError,
    estimate_calls,
    event_out,
    workflow_summary,
)
from app.schemas import TaskOut, dump
from app.services.staffing import available_members

router = APIRouter(prefix="/api/workflows", tags=["workflows"])
Session = Annotated[AsyncSession, Depends(get_session)]


def orchestrator(request: Request) -> Orchestrator:
    return request.app.state.workflows


Engine = Annotated[Orchestrator, Depends(orchestrator)]


def _error(error: WorkflowError) -> HTTPException:
    return HTTPException(error.status, str(error))


class WorkflowCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    objective: str | None = Field(default=None, max_length=8000)
    title: str | None = Field(default=None, max_length=160)
    source_conversation_id: str | None = None
    source_message_id: int | None = None
    source_task_id: str | None = None
    max_calls: int = Field(default=DEFAULT_MAX_CALLS, ge=5, le=120)


class Approval(BaseModel):
    model_config = ConfigDict(extra="forbid")

    exclude: list[str] = Field(default_factory=list, max_length=10)


async def _detail(
    session: AsyncSession, workflow: Workflow, engine: Orchestrator
) -> dict[str, Any]:
    tasks = list(
        await session.scalars(
            select(Task)
            .where(Task.workflow_id == workflow.id)
            .order_by(Task.position, Task.created_at)
        )
    )
    events = list(
        await session.scalars(
            select(WorkflowEvent)
            .where(WorkflowEvent.workflow_id == workflow.id)
            .order_by(WorkflowEvent.id)
        )
    )
    assignments = [
        t for t in tasks if t.kind == "assignment" and t.status not in (TaskStatus.CANCELLED,)
    ]
    sizes = {a.department: len(await available_members(session, a.department)) for a in assignments}
    return {
        **await workflow_summary(session, workflow, engine),
        "plan": workflow.plan,
        "result": workflow.result,
        "estimate": estimate_calls(assignments, sizes) if workflow.plan else None,
        "tasks": [dump(TaskOut.model_validate(t)) for t in tasks],
        "events": [event_out(e) for e in events],
    }


@router.get("")
async def list_workflows(
    session: Session, engine: Engine, status: str | None = None
) -> list[dict[str, Any]]:
    query = select(Workflow)
    if status:
        query = query.where(Workflow.status == status)
    workflows = list(await session.scalars(query.order_by(Workflow.created_at.desc()).limit(200)))
    return [await workflow_summary(session, w, engine) for w in workflows]


@router.post("", status_code=201)
async def create_workflow(body: WorkflowCreate, session: Session, engine: Engine) -> dict[str, Any]:
    """Hands an objective to the CEO, who drafts a plan for the owner to approve."""
    objective = (body.objective or "").strip()
    conversation_id = body.source_conversation_id
    if body.source_message_id is not None:
        message = await session.get(Message, body.source_message_id)
        if message is None or message.role != MessageRole.OWNER:
            raise HTTPException(404, "Owner message not found")
        conversation_id = message.conversation_id
        objective = objective or message.content.strip()
    if conversation_id and await session.get(Conversation, conversation_id) is None:
        raise HTTPException(404, "Conversation not found")
    if body.source_task_id:
        task = await session.get(Task, body.source_task_id)
        if task is None or task.kind != "manual":
            raise HTTPException(404, "Recorded task not found")
        if task.status != TaskStatus.OPEN:
            raise HTTPException(409, "Only an open recorded task can be handed to the CEO.")
        objective = objective or f"{task.title}\n\n{task.description}".strip()
    if len(objective) < 10:
        raise HTTPException(422, "Describe the objective in at least a sentence.")
    try:
        workflow = await engine.create(
            session,
            objective,
            title=body.title,
            conversation_id=conversation_id,
            source_task_id=body.source_task_id,
            max_calls=body.max_calls,
        )
    except WorkflowError as error:
        raise _error(error) from error
    return await _detail(session, workflow, engine)


@router.get("/{workflow_id}")
async def get_workflow(workflow_id: str, session: Session, engine: Engine) -> dict[str, Any]:
    workflow = await session.get(Workflow, workflow_id)
    if workflow is None:
        raise HTTPException(404, "Workflow not found")
    return await _detail(session, workflow, engine)


@router.post("/{workflow_id}/approve")
async def approve(
    workflow_id: str, body: Approval, session: Session, engine: Engine
) -> dict[str, Any]:
    """Owner checkpoint: the plan runs only after this call."""
    try:
        workflow = await engine.approve(session, workflow_id, body.exclude)
    except WorkflowError as error:
        raise _error(error) from error
    await session.refresh(workflow)
    return await _detail(session, workflow, engine)


async def _after(session: AsyncSession, workflow_id: str, engine: Orchestrator) -> dict[str, Any]:
    workflow = await session.get(Workflow, workflow_id, populate_existing=True)
    if workflow is None:
        raise HTTPException(404, "Workflow not found")
    return await _detail(session, workflow, engine)


@router.post("/{workflow_id}/cancel")
async def cancel(workflow_id: str, session: Session, engine: Engine) -> dict[str, Any]:
    try:
        await engine.cancel(workflow_id)
    except WorkflowError as error:
        raise _error(error) from error
    return await _after(session, workflow_id, engine)


@router.post("/{workflow_id}/resume")
async def resume(workflow_id: str, session: Session, engine: Engine) -> dict[str, Any]:
    try:
        await engine.resume(workflow_id)
    except WorkflowError as error:
        raise _error(error) from error
    return await _after(session, workflow_id, engine)


@router.post("/{workflow_id}/tasks/{task_id}/cancel")
async def cancel_task(
    workflow_id: str, task_id: str, session: Session, engine: Engine
) -> dict[str, Any]:
    try:
        await engine.cancel_task(workflow_id, task_id)
    except WorkflowError as error:
        raise _error(error) from error
    return await _after(session, workflow_id, engine)
