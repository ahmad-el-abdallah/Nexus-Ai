"""Tasks the owner gives an employee are actually done, like in a real company.

A recorded task (from chat or the task board) is picked up by its assignee — or the
department's director when nobody is assigned — who writes the deliverable with
their model (streamed onto their desk monitor). The result is stored on the task
and posted by the employee in the conversation the task came from. Agents produce
text only: nothing external happens, so no approval is needed to run a task.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from app.ai.gateway import AIGateway, GatewayError
from app.core.events import EventBus
from app.core.logging import get_logger
from app.db.session import Database
from app.models import (
    Conversation,
    Department,
    Employee,
    EmployeeStatus,
    Message,
    MessageRole,
    MessageStatus,
    Task,
    TaskStatus,
)
from app.orchestration.prompts import RULES, clean_text
from app.schemas import TaskOut, dump
from app.services.activity import ActivityTracker, Screen
from app.services.chat import ChatService

if TYPE_CHECKING:
    from app.storage.artifacts import ArtifactRegistrar

log = get_logger("nexus.tasks")

TASK_TOKENS = 3000
CONTEXT_MESSAGES = 6
CONTEXT_CHARS = 1500
RUNNABLE = (TaskStatus.OPEN, TaskStatus.FAILED, TaskStatus.CANCELLED)


class TaskRunError(Exception):
    def __init__(self, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.status = status


def task_prompt(task: Task, conversation: list[Message]) -> str:
    parts = [
        "Format: NEXUS-TASK/1",
        "The owner of NEXUS AI gave you this task. Do it now and reply with the finished "
        "deliverable itself (the text, plan, analysis, draft or code that was asked for) — "
        "not a description of what you are going to do. Use Markdown where it helps.",
        "",
        f"Task: {task.title}",
    ]
    if task.description and task.description.strip() != task.title.strip():
        parts += ["Details:", task.description.strip()]
    if conversation:
        parts += ["", "The conversation the task came from (for context; earlier first):"]
        for m in conversation:
            who = "Owner" if m.role == MessageRole.OWNER else (m.author_name or "Employee")
            text = m.content.strip()
            if len(text) > CONTEXT_CHARS:
                text = text[:CONTEXT_CHARS].rstrip() + " […]"
            parts.append(f"<<<{who}\n{text}\n{who}>>>")
    parts += [
        "",
        "If something essential is missing, make a reasonable assumption, state it, and "
        "still deliver. Reply in English. Build the deliverable fully and for real "
        "(complete, working code or content), not a summary of what you would do.",
    ]
    return "\n".join(parts)


class TaskRunner:
    def __init__(
        self,
        database: Database,
        gateway: AIGateway,
        events: EventBus,
        activity: ActivityTracker,
        chat: ChatService,
        artifacts: ArtifactRegistrar | None = None,
    ) -> None:
        self.database = database
        self.gateway = gateway
        self.events = events
        self.activity = activity
        self.chat = chat
        self.artifacts = artifacts
        self.running: dict[str, asyncio.Task[None]] = {}
        self._closing = False

    async def _publish(self, task_id: str) -> None:
        async with self.database.sessionmaker() as session:
            task = await session.get(Task, task_id)
            if task is not None:
                self.events.publish("task.updated", dump(TaskOut.model_validate(task)))

    async def start(self, task_id: str) -> Task:
        """Starts (or restarts) a recorded task; returns it as "running"."""
        async with self.database.sessionmaker() as session:
            task = await session.get(Task, task_id)
            if task is None:
                raise TaskRunError("Task not found", 404)
            if task.kind != "manual":
                raise TaskRunError("Workflow tasks are run by their workflow.")
            if task_id in self.running or task.status == TaskStatus.RUNNING:
                raise TaskRunError("This task is already being worked on.")
            if task.status not in RUNNABLE:
                raise TaskRunError("Only an open, failed or cancelled task can be started.")
            employee = await self._worker(session, task)
            task.assignee_id = employee.id
            task.status = TaskStatus.RUNNING.value
            task.attempts += 1
            task.error = None
            task.result = None
            task.started_at = datetime.now(UTC)
            task.finished_at = None
            await session.commit()
            await session.refresh(task)
        await self._publish(task_id)
        self.running[task_id] = asyncio.create_task(self._run(task_id), name=f"task-{task_id}")
        return task

    async def _worker(self, session: Any, task: Task) -> Employee:
        if task.assignee_id:
            employee = await session.get(Employee, task.assignee_id)
            if employee is None:
                raise TaskRunError("The assignee no longer works here; choose someone else.")
            if employee.status == EmployeeStatus.SUSPENDED:
                raise TaskRunError(
                    f"{employee.name} is suspended; activate them or reassign the task."
                )
            return employee
        department = await session.get(Department, task.department)
        members = list(
            await session.scalars(
                select(Employee).where(
                    Employee.department == task.department,
                    Employee.status != EmployeeStatus.SUSPENDED.value,
                )
            )
        )
        if not members:
            raise TaskRunError("Nobody in this department can take the task (nobody available).")
        director = next((m for m in members if department and m.id == department.director_id), None)
        return director or sorted(members, key=lambda m: m.name)[0]

    async def cancel(self, task_id: str) -> bool:
        run = self.running.pop(task_id, None)
        if run is None:
            return False
        run.cancel()
        await asyncio.gather(run, return_exceptions=True)
        return True

    async def _context(self, session: Any, task: Task) -> list[Message]:
        if not task.source_conversation_id:
            return []
        query = select(Message).where(
            Message.conversation_id == task.source_conversation_id,
            Message.role.in_([MessageRole.OWNER.value, MessageRole.AGENT.value]),
            Message.status == MessageStatus.COMPLETE.value,
        )
        if task.source_message_id:
            query = query.where(Message.id <= task.source_message_id)
        rows = list(
            await session.scalars(query.order_by(Message.id.desc()).limit(CONTEXT_MESSAGES))
        )
        return list(reversed(rows))

    async def _run(self, task_id: str) -> None:
        async with self.database.sessionmaker() as session:
            task = await session.get(Task, task_id)
            assert task is not None
            employee = await session.get(Employee, task.assignee_id)
            assert employee is not None
            prompt = task_prompt(task, await self._context(session, task))
            title, brief = task.title, task.description or task.title
        token = await self.activity.begin(
            employee.id,
            EmployeeStatus.WORKING.value,
            f"Task: {title}",
            Screen("work", title, brief=brief),
        )
        completion = None
        written = ""
        events = None
        try:
            async with self.database.sessionmaker() as session:
                _, events = await self.gateway.stream(
                    session,
                    [{"role": "user", "content": prompt}],
                    employee_id=employee.id,
                    purpose="task",
                    context=RULES.replace("inside a NEXUS AI workflow", "on a task from the owner"),
                    max_tokens=TASK_TOKENS,
                )
            async for event in events:
                if event.kind == "reasoning":
                    self.activity.update_screen(employee.id, token, thinking=True)
                elif event.kind == "text" and event.text:
                    written += event.text
                    self.activity.update_screen(employee.id, token, text=written)
                elif event.kind == "done":
                    completion = event.completion
            result = clean_text(completion.content or "") if completion else ""
            if not result:
                raise GatewayError("empty", "The model returned no visible text.")
        except asyncio.CancelledError:
            if events is not None:
                await asyncio.shield(events.aclose())  # type: ignore[attr-defined]
            await asyncio.shield(self.activity.end(employee.id, token, screen_failed=True))
            if not self._closing:  # shutting down: `recover` marks it on the next start
                await asyncio.shield(
                    self._finish(task_id, TaskStatus.CANCELLED, error="Cancelled by the owner.")
                )
            raise
        except GatewayError as error:
            if events is not None:
                await events.aclose()  # type: ignore[attr-defined]
            await self.activity.end(
                employee.id, token, "error", f"Task failed: {title}", screen_failed=True
            )
            # Report in the chat first, so "failed" never shows without the reason there.
            await self._post(
                task_id, employee, f"I couldn't finish the task “{title}”: {error}", failed=True
            )
            await self._finish(task_id, TaskStatus.FAILED, error=str(error))
            return
        finally:
            self.running.pop(task_id, None)
        await self.activity.end(employee.id, token, "completed", f"Finished: {title}")
        # The result is in the chat before the task shows as done.
        await self._post(
            task_id,
            employee,
            f"✅ **Task done: {title}**\n\n{result}",
            model=completion.model if completion else None,
        )
        await self._finish(task_id, TaskStatus.DONE, result=result, completion=completion)

    async def _finish(
        self,
        task_id: str,
        status: TaskStatus,
        *,
        result: str | None = None,
        error: str | None = None,
        completion: Any = None,
    ) -> None:
        async with self.database.sessionmaker() as session:
            task = await session.get(Task, task_id)
            if task is None or task.status != TaskStatus.RUNNING:
                return
            task.status = status.value
            task.finished_at = datetime.now(UTC)
            task.result = result
            task.error = error
            if completion is not None:
                task.calls += 1
                task.prompt_tokens += completion.prompt_tokens or 0
                task.completion_tokens += completion.completion_tokens or 0
            await session.commit()
        if status == TaskStatus.DONE and result and self.artifacts:
            try:
                await self.artifacts.register_task(task_id)
            except Exception:
                log.exception("task.artifact_registration_failed", task_id=task_id)
        await self._publish(task_id)
        log.info("task.finished", task_id=task_id, status=status.value)

    async def _post(
        self,
        task_id: str,
        employee: Employee,
        content: str,
        *,
        failed: bool = False,
        model: str | None = None,
    ) -> None:
        """The employee reports back in the conversation the task came from."""
        async with self.database.sessionmaker() as session:
            task = await session.get(Task, task_id)
            if task is None or not task.source_conversation_id:
                return
            conversation = await session.get(Conversation, task.source_conversation_id)
            if conversation is None:
                return
            message = Message(
                conversation_id=conversation.id,
                role=MessageRole.AGENT.value,
                employee_id=employee.id,
                author_name=employee.name,
                author_role=employee.role,
                author_department=employee.department,
                content=content,
                status=MessageStatus.COMPLETE.value,
                model=model,
                finished_at=datetime.now(UTC),
            )
            session.add(message)
            conversation.last_message_at = datetime.now(UTC)
            await session.commit()
            await session.refresh(message)
            await self.chat.publish_message(session, message, "message.created")
        log.info("task.reported", task_id=task_id, failed=failed)

    async def recover(self) -> int:
        """A restart interrupts tasks in progress: they are marked failed (run them again)."""
        async with self.database.sessionmaker() as session:
            rows = list(
                await session.scalars(
                    select(Task).where(
                        Task.kind == "manual", Task.status == TaskStatus.RUNNING.value
                    )
                )
            )
            for task in rows:
                task.status = TaskStatus.FAILED.value
                task.error = "NEXUS restarted while this task was being worked on. Run it again."
                task.finished_at = datetime.now(UTC)
            await session.commit()
        return len(rows)

    async def shutdown(self) -> None:
        self._closing = True
        runs = list(self.running.values())
        for run in runs:
            run.cancel()
        if runs:
            await asyncio.gather(*runs, return_exceptions=True)
