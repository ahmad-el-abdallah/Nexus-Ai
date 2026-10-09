"""The workflow engine: CEO delegation → department supervisors → workers → review →
department results → CEO consolidation.

A persisted state machine. Every transition is written to the database before the
next step starts, so the owner sees real progress and a restart loses nothing but
the model calls in flight (those workflows pause and wait for "Resume").

Safety rails, all enforced here in code:
  * nothing runs until the owner approves the CEO's plan;
  * hard limits: ≤ 4 departments, ≤ 2 tasks each, ≤ 1 revision per task, a per-workflow
    cap on model requests, and a wall-clock limit — so agents can never loop;
  * dependencies must form a DAG; a failed dependency skips its dependents;
  * retries only for transient failures (timeouts, rate limits, unusable replies);
    budget exhaustion or the emergency stop pause the workflow instead of failing it;
  * agents produce text only — no tools, no external actions.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.gateway import AIGateway, GatewayError
from app.core.events import EventBus
from app.core.logging import get_logger
from app.db.session import Database
from app.models import (
    FINISHED,
    TERMINAL,
    Department,
    Employee,
    EmployeeStatus,
    Message,
    MessageRole,
    MessageStatus,
    Task,
    TaskStatus,
    Workflow,
    WorkflowEvent,
    WorkflowStatus,
)
from app.orchestration import plans, prompts
from app.schemas import TaskOut, dump
from app.services.activity import ActivityTracker, Screen
from app.services.org import CEO_DEPARTMENT
from app.services.staffing import available_ceo, available_members, lead_of

if TYPE_CHECKING:
    from app.storage.artifacts import ArtifactRegistrar

log = get_logger("nexus.workflows")

DEFAULT_MAX_CALLS = 45
MAX_ATTEMPTS = 2
MAX_REVISIONS = 1
MAX_RUN_SECONDS = 45 * 60
MAX_TOKENS = {
    "plan": 3000,
    "breakdown": 1500,
    "work": 2000,
    "review": 900,
    "summary": 1800,
    "report": 3500,
}

# Gateway refusals that a later retry can fix only after the owner acts: pause.
PAUSE_KINDS = {"paused", "budget", "not_configured", "no_model", "key_unreadable", "quota"}
# Transient failures worth one more attempt.
RETRY_KINDS = {"timeout", "rate_limited", "provider_unavailable", "network", "empty"}

ACTIVE = (WorkflowStatus.PLANNING, WorkflowStatus.RUNNING, WorkflowStatus.CONSOLIDATING)


class WorkflowError(Exception):
    def __init__(self, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.status = status


class _Pause(Exception):
    pass


class _LimitReached(Exception):
    pass


class _StepFailed(Exception):
    pass


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def now() -> datetime:
    return datetime.now(UTC)


def title_for(objective: str) -> str:
    line = next((ln.strip() for ln in objective.splitlines() if ln.strip()), "Workflow")
    return line if len(line) <= 100 else line[:97].rstrip() + "…"


@dataclass
class Run:
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    driver: asyncio.Task[None] | None = None
    steps: dict[str, asyncio.Task[None]] = field(default_factory=dict)
    calls_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    started: float = field(default_factory=time.monotonic)
    last_model: str | None = None  # model of the latest call (credited on the final report)


class Orchestrator:
    def __init__(
        self,
        database: Database,
        gateway: AIGateway,
        events: EventBus,
        activity: ActivityTracker,
        chat: Any,
        artifacts: ArtifactRegistrar | None = None,
    ) -> None:
        self.database = database
        self.gateway = gateway
        self.events = events
        self.activity = activity
        self.chat = chat
        self.artifacts = artifacts
        self.runs: dict[str, Run] = {}

    # =============================================================== owner API

    async def create(
        self,
        session: AsyncSession,
        objective: str,
        *,
        title: str | None = None,
        conversation_id: str | None = None,
        source_task_id: str | None = None,
        max_calls: int = DEFAULT_MAX_CALLS,
    ) -> Workflow:
        ceo = await available_ceo(session)
        if ceo is None:
            raise WorkflowError(
                "The CEO is unavailable (suspended or not appointed), so nobody can plan the work."
            )
        workflow = Workflow(
            id=new_id("wf"),
            title=(title or title_for(objective)).strip()[:160],
            objective=objective.strip(),
            status=WorkflowStatus.PLANNING.value,
            ceo_id=ceo.id,
            max_calls=max_calls,
            calls_used=0,
            prompt_tokens=0,
            completion_tokens=0,
            plan_attempts=0,
            source_conversation_id=conversation_id,
            source_task_id=source_task_id,
        )
        session.add(workflow)
        await self._commit_with(
            session,
            workflow,
            "created",
            f"The owner asked the CEO: “{workflow.title}”.",
            actor=ceo,
            messages=[
                self._notice(
                    workflow,
                    f"Workflow started: {ceo.name} is drafting a plan for “{workflow.title}”. Nothing runs until you approve the plan.",
                )
            ],
        )
        await session.refresh(workflow)
        await self._publish(workflow.id)
        self.start(workflow.id)
        return workflow

    async def approve(
        self, session: AsyncSession, workflow_id: str, exclude: list[str]
    ) -> Workflow:
        """Owner checkpoint: only an approved plan ever runs."""
        workflow = await self._get(session, workflow_id)
        if workflow.status != WorkflowStatus.AWAITING_APPROVAL:
            raise WorkflowError("Only a plan that is awaiting approval can be approved.")
        assignments = await self._tasks(session, workflow_id, "assignment")
        unknown = set(exclude) - {a.id for a in assignments}
        if unknown:
            raise WorkflowError("Unknown assignment in the exclusion list.", 422)
        kept = [a for a in assignments if a.id not in exclude]
        if not kept:
            raise WorkflowError("Keep at least one department in the plan.", 422)
        stamp = now()
        for a in assignments:
            if a.id in exclude:
                a.status = TaskStatus.CANCELLED.value
                a.error = "Removed from the plan by the owner."
                a.finished_at = stamp
            else:
                a.status = TaskStatus.QUEUED.value
                # The owner removed a department: its dependents go ahead without that input.
                a.depends_on = [d for d in a.depends_on if d not in exclude]
        workflow.status = WorkflowStatus.RUNNING.value
        workflow.approved_at = workflow.started_at = stamp
        workflow.status_reason = None
        await session.commit()
        ceo = await session.get(Employee, workflow.ceo_id) if workflow.ceo_id else None
        await self._event(
            workflow_id,
            "approved",
            f"The owner approved the plan ({len(kept)} department{'s' if len(kept) != 1 else ''}).",
        )
        departments = {d.key: d.name for d in await session.scalars(select(Department))}
        for a in kept:
            lead = await session.get(Employee, a.assignee_id) if a.assignee_id else None
            await self._event(
                workflow_id,
                "delegated",
                f"{ceo.name if ceo else 'The CEO'} delegated “{a.title}” to {departments.get(a.department, a.department)}"
                + (f" ({lead.name})" if lead else "")
                + ".",
                task_id=a.id,
                actor=ceo,
                from_department=CEO_DEPARTMENT,
                to_department=a.department,
            )
        for a in assignments:
            await self._publish_task(a)
        await self._publish(workflow_id)
        self.start(workflow_id)
        return workflow

    async def cancel(self, workflow_id: str, reason: str = "Cancelled by the owner.") -> None:
        async with self.database.sessionmaker() as session:
            workflow = await self._get(session, workflow_id)
            if workflow.status in FINISHED:
                raise WorkflowError("This workflow has already finished.")
        await self._halt(workflow_id)  # stop in-flight work before recording the cancellation
        async with self.database.sessionmaker() as session:
            workflow = await self._get(session, workflow_id)
            if workflow.status in FINISHED:
                raise WorkflowError("This workflow has already finished.")
            workflow.status = WorkflowStatus.CANCELLED.value
            workflow.status_reason = reason
            workflow.finished_at = now()
            changed = await self._close_open_tasks(
                session, workflow_id, TaskStatus.CANCELLED, reason
            )
            await self._commit_with(
                session,
                workflow,
                "cancelled",
                reason,
                messages=[self._notice(workflow, f"Workflow cancelled: {reason}")],
            )
        for task in changed:
            await self._publish_task(task)
        await self._publish(workflow_id)
        await self._refresh_people(workflow_id)

    async def cancel_task(self, workflow_id: str, task_id: str) -> None:
        """Cancels one assignment (with its tasks) or one worker task. Dependents are skipped."""
        async with self.database.sessionmaker() as session:
            workflow = await self._get(session, workflow_id)
            if workflow.status in FINISHED:
                raise WorkflowError("This workflow has already finished.")
            task = await session.get(Task, task_id)
            if task is None or task.workflow_id != workflow_id:
                raise WorkflowError("Task not found in this workflow.", 404)
            if task.status in TERMINAL:
                raise WorkflowError("This task has already finished.")
            targets = [task]
            if task.kind == "assignment":
                targets += [
                    t
                    for t in await self._tasks(session, workflow_id, "work")
                    if t.parent_id == task.id and t.status not in TERMINAL
                ]
            ids = {t.id for t in targets}
        run = self.runs.get(workflow_id)
        if run:
            await self._halt(workflow_id, {k for k in run.steps if k.partition(":")[2] in ids})
        async with self.database.sessionmaker() as session:
            targets = [
                t
                for t in [await session.get(Task, i) for i in ids]
                if t and t.status not in TERMINAL
            ]
            for t in targets:
                t.status = TaskStatus.CANCELLED.value
                t.error = "Cancelled by the owner."
                t.finished_at = now()
            await session.commit()
        if run:
            run.wake.set()
        await self._event(
            workflow_id, "task_cancelled", f"The owner cancelled “{task.title}”.", task_id=task.id
        )
        for t in targets:
            await self._publish_task(t)
        await self._publish(workflow_id)
        await self._refresh_people(workflow_id)

    async def resume(self, workflow_id: str) -> None:
        async with self.database.sessionmaker() as session:
            workflow = await self._get(session, workflow_id)
            if workflow.status not in (WorkflowStatus.PAUSED, WorkflowStatus.FAILED):
                raise WorkflowError("Only a paused or failed workflow can be resumed.")
            if (
                workflow.status == WorkflowStatus.FAILED
                and workflow.calls_used >= workflow.max_calls
            ):
                raise WorkflowError(
                    "This workflow used all of its model requests; start a new one."
                )
            if workflow.plan is None:
                workflow.status = WorkflowStatus.PLANNING.value
                workflow.plan_attempts = 0
            elif workflow.approved_at is None:
                workflow.status = WorkflowStatus.AWAITING_APPROVAL.value
            else:
                workflow.status = WorkflowStatus.RUNNING.value
                workflow.finished_at = None
            workflow.status_reason = None
            await session.commit()
        await self._event(workflow_id, "resumed", "The owner resumed the workflow.")
        await self._publish(workflow_id)
        self.start(workflow_id)

    async def recover(self) -> None:
        """After a restart nothing is running: active workflows pause, in-flight steps
        go back to waiting, and the owner decides when to resume."""
        reverts = {
            TaskStatus.RUNNING: TaskStatus.QUEUED,
            TaskStatus.REVIEWING: TaskStatus.AWAITING_REVIEW,
            TaskStatus.PLANNING: TaskStatus.QUEUED,
            TaskStatus.SUMMARIZING: TaskStatus.ACTIVE,
        }
        async with self.database.sessionmaker() as session:
            workflows = list(
                await session.scalars(
                    select(Workflow).where(Workflow.status.in_([s.value for s in ACTIVE]))
                )
            )
            for workflow in workflows:
                workflow.status = WorkflowStatus.PAUSED.value
                workflow.status_reason = "The server restarted while this workflow was running. Press Resume to continue."
                for task in await self._tasks(session, workflow.id):
                    if task.status in reverts:
                        task.status = reverts[TaskStatus(task.status)].value
            await session.commit()
        for workflow in workflows:
            await self._event(workflow.id, "paused", workflow.status_reason or "Paused.")
        if workflows:
            log.warning("workflows.recovered", paused=len(workflows))

    async def shutdown(self) -> None:
        for workflow_id in list(self.runs):
            await self._halt(workflow_id)

    # ================================================================== driver

    def start(self, workflow_id: str) -> None:
        run = self.runs.setdefault(workflow_id, Run())
        if run.driver is None or run.driver.done():
            run.started = time.monotonic()
            run.driver = asyncio.create_task(
                self._drive(workflow_id), name=f"workflow-{workflow_id}"
            )
        run.wake.set()

    def _stop_steps(self, workflow_id: str) -> list[asyncio.Task[None]]:
        run = self.runs.get(workflow_id)
        if not run:
            return []
        stopped = [step for step in run.steps.values() if not step.done()]
        if run.driver and not run.driver.done():
            stopped.append(run.driver)
        for task in stopped:
            task.cancel()
        return stopped

    async def _halt(self, workflow_id: str, keys: set[str] | None = None) -> None:
        """Stops in-flight steps (all, or those for `keys`) and waits until they have
        let go, so nothing they were doing can overwrite what happens next."""
        run = self.runs.get(workflow_id)
        if not run:
            return
        if keys is None:
            stopped = self._stop_steps(workflow_id)
        else:
            stopped = [step for key, step in run.steps.items() if key in keys and not step.done()]
            for step in stopped:
                step.cancel()
        current = asyncio.current_task()
        waiting = [t for t in stopped if t is not current]
        if waiting:
            await asyncio.wait(waiting, timeout=10)

    async def _drive(self, workflow_id: str) -> None:
        run = self.runs[workflow_id]
        try:
            while True:
                run.wake.clear()
                async with self.database.sessionmaker() as session:
                    workflow = await session.get(Workflow, workflow_id)
                    if workflow is None or workflow.status not in ACTIVE:
                        break
                    if time.monotonic() - run.started > MAX_RUN_SECONDS:
                        await self._fail(
                            workflow_id,
                            f"Stopped: the workflow ran longer than {MAX_RUN_SECONDS // 60} minutes.",
                        )
                        break
                    starts, changed = await self._advance(session, workflow)
                for key, step in starts:
                    if key not in run.steps:
                        run.steps[key] = asyncio.create_task(
                            self._step(workflow_id, key, step), name=f"{workflow_id}:{key}"
                        )
                if run.steps:
                    await run.wake.wait()
                elif not changed:
                    break
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("workflow.driver_crashed", workflow_id=workflow_id)
            await self._fail(
                workflow_id, "Internal error in the workflow engine (see the server log)."
            )

    async def _step(self, workflow_id: str, key: str, step: Callable[[], Awaitable[None]]) -> None:
        run = self.runs[workflow_id]
        try:
            await step()
        except _Pause as pause:
            await self._revert(workflow_id, key)
            await self._pause(workflow_id, str(pause))
        except _LimitReached:
            async with self.database.sessionmaker() as session:
                workflow = await session.get(Workflow, workflow_id)
                limit = workflow.max_calls if workflow else DEFAULT_MAX_CALLS
            await self._fail(
                workflow_id,
                f"Stopped at the safety limit of {limit} model requests for one workflow.",
            )
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("workflow.step_crashed", workflow_id=workflow_id, step=key)
            await self._fail(
                workflow_id, f"Internal error during step {key.split(':')[0]} (see the server log)."
            )
        finally:
            run.steps.pop(key, None)
            run.wake.set()

    async def _advance(
        self, session: AsyncSession, workflow: Workflow
    ) -> tuple[list[tuple[str, Callable[[], Awaitable[None]]]], bool]:
        """Applies the transitions that need no model call and returns the steps to start."""
        wid = workflow.id
        starts: list[tuple[str, Callable[[], Awaitable[None]]]] = []
        changed_tasks: list[Task] = []
        notes: list[tuple[str, str, str | None]] = []
        if workflow.status == WorkflowStatus.PLANNING:
            starts.append(("plan", lambda: self._plan(wid)))
            return starts, False

        tasks = await self._tasks(session, wid)
        by_id = {t.id: t for t in tasks}
        assignments = [t for t in tasks if t.kind == "assignment"]
        works: dict[str, list[Task]] = {}
        for t in tasks:
            if t.kind == "work" and t.parent_id:
                works.setdefault(t.parent_id, []).append(t)
        stamp = now()

        for a in assignments:
            status = TaskStatus(a.status)
            if status == TaskStatus.QUEUED:
                deps = [by_id[d] for d in a.depends_on if d in by_id]
                broken = [
                    d
                    for d in deps
                    if d.status in (TaskStatus.FAILED, TaskStatus.SKIPPED, TaskStatus.CANCELLED)
                ]
                if broken:
                    a.status = TaskStatus.SKIPPED.value
                    a.error = f"Skipped: it needed “{broken[0].title}”, which did not complete."
                    a.finished_at = stamp
                    changed_tasks.append(a)
                    notes.append(("skipped", a.error, a.id))
                elif all(d.status == TaskStatus.DONE for d in deps):
                    a.status = TaskStatus.PLANNING.value
                    a.started_at = a.started_at or stamp
                    changed_tasks.append(a)
                    starts.append((f"breakdown:{a.id}", lambda aid=a.id: self._breakdown(wid, aid)))
            elif status == TaskStatus.ACTIVE:
                team_tasks = works.get(a.id, [])
                if team_tasks and all(w.status in TERMINAL for w in team_tasks):
                    done = [w for w in team_tasks if w.status == TaskStatus.DONE]
                    if not done:
                        a.status = TaskStatus.FAILED.value
                        a.error = "None of the department's tasks completed."
                        a.finished_at = stamp
                        changed_tasks.append(a)
                        notes.append(("failed", f"“{a.title}” failed: {a.error}", a.id))
                    elif len(done) == 1:
                        a.result = done[0].result
                        a.status = TaskStatus.DONE.value
                        a.finished_at = stamp
                        changed_tasks.append(a)
                        notes.append(("department_done", f"“{a.title}” is complete.", a.id))
                    else:
                        a.status = TaskStatus.SUMMARIZING.value
                        changed_tasks.append(a)
                        starts.append((f"summary:{a.id}", lambda aid=a.id: self._summary(wid, aid)))
                else:
                    for w in team_tasks:
                        if w.status == TaskStatus.QUEUED:
                            w.status = TaskStatus.RUNNING.value
                            w.started_at = w.started_at or stamp
                            changed_tasks.append(w)
                            starts.append((f"work:{w.id}", lambda tid=w.id: self._work(wid, tid)))
                        elif w.status == TaskStatus.AWAITING_REVIEW:
                            w.status = TaskStatus.REVIEWING.value
                            changed_tasks.append(w)
                            starts.append(
                                (f"review:{w.id}", lambda tid=w.id: self._review(wid, tid))
                            )

        if (
            workflow.status == WorkflowStatus.RUNNING
            and assignments
            and all(a.status in TERMINAL for a in assignments)
        ):
            workflow.status = WorkflowStatus.CONSOLIDATING.value
            starts.append(("consolidate", lambda: self._consolidate(wid)))
            changed = True
        elif workflow.status == WorkflowStatus.CONSOLIDATING:
            starts.append(("consolidate", lambda: self._consolidate(wid)))
            changed = bool(changed_tasks)
        else:
            changed = bool(changed_tasks)

        if changed or changed_tasks:
            await session.commit()
            for task in changed_tasks:
                if task.status == TaskStatus.DONE.value and task.result:
                    await self._register_task_artifact(task.id)
            for kind, text, task_id in notes:
                await self._event(wid, kind, text, task_id=task_id)
            for t in changed_tasks:
                await self._publish_task(t)
            await self._publish(wid)
            await self._refresh_people(wid)
        return starts, changed

    # =================================================================== steps

    async def _plan(self, workflow_id: str) -> None:
        async with self.database.sessionmaker() as session:
            workflow = await self._get(session, workflow_id)
            ceo = await available_ceo(session)
            if ceo is None:
                await self._fail(
                    workflow_id, "The CEO is unavailable (suspended), so the plan can't be drafted."
                )
                return
            departments: list[prompts.DepartmentInfo] = []
            leads: dict[str, Employee] = {}
            for d in await session.scalars(select(Department).order_by(Department.position)):
                if d.key == CEO_DEPARTMENT:
                    continue
                members = await available_members(session, d.key)
                lead = lead_of(d, members)
                if lead is None:
                    continue
                leads[d.key] = lead
                departments.append(
                    prompts.DepartmentInfo(d.key, d.name, lead.name, d.description, len(members))
                )
            objective, title = workflow.objective, workflow.title
        available = {d.key: d.name for d in departments}
        base = prompts.plan_prompt(objective, departments)

        async def attempt(previous_error: str | None) -> plans.Plan:
            prompt = (
                base
                if not previous_error
                else f"{base}\n\nYour previous reply could not be used: {previous_error} Reply again with valid JSON only."
            )
            text = await self._ask(
                workflow_id,
                None,
                ceo,
                "workflow_plan",
                prompt,
                EmployeeStatus.WORKING.value,
                f"Planning: {title}",
                MAX_TOKENS["plan"],
                screen=Screen("plan", f"Plan: {title}", brief=objective),
            )
            return plans.parse_plan(text, available)

        try:
            plan = await self._attempts(workflow_id, None, "Plan", attempt)
        except _StepFailed as failed:
            await self._fail(workflow_id, f"The CEO's plan could not be used: {failed}")
            return

        ids = {a.id: new_id("tsk") for a in plan.assignments}
        async with self.database.sessionmaker() as session:
            workflow = await self._get(session, workflow_id)
            if workflow.status != WorkflowStatus.PLANNING:
                return
            created = []
            for position, a in enumerate(plan.assignments):
                task = Task(
                    id=ids[a.id],
                    title=a.title,
                    description=a.instructions,
                    department=a.department,
                    assignee_id=leads[a.department].id,
                    status=TaskStatus.PROPOSED.value,
                    kind="assignment",
                    workflow_id=workflow_id,
                    depends_on=[ids[d] for d in a.depends_on],
                    position=position,
                )
                session.add(task)
                created.append(task)
            workflow.plan = plan.model_dump()
            workflow.status = WorkflowStatus.AWAITING_APPROVAL.value
            count = f"{len(created)} department{'s' if len(created) != 1 else ''}"
            await self._commit_with(
                session,
                workflow,
                "plan_proposed",
                f"{ceo.name} proposed a plan for {count}: {plan.summary}",
                actor=ceo,
                messages=[
                    self._notice(
                        workflow,
                        f"The CEO's plan is ready ({count}). Review and approve it on the workflow page — nothing runs before you do.",
                    )
                ],
            )
        for task in created:
            await self._publish_task(task)
        await self._publish(workflow_id)

    async def _breakdown(self, workflow_id: str, assignment_id: str) -> None:
        async with self.database.sessionmaker() as session:
            workflow = await self._get(session, workflow_id)
            a = await session.get(Task, assignment_id)
            department = await session.get(Department, a.department) if a else None
            if a is None or department is None or a.status != TaskStatus.PLANNING:
                return
            members = await available_members(session, a.department)
            lead = lead_of(department, members)
            if lead is None:
                reason = f"Nobody in {department.name} is available (all suspended)."
                await self._finish_task(
                    assignment_id, TaskStatus.FAILED, error=reason, expect=TaskStatus.PLANNING
                )
                await self._event(
                    workflow_id, "failed", f"“{a.title}” failed: {reason}", task_id=assignment_id
                )
                return
            a.assignee_id = lead.id
            await session.commit()
            handoffs = await self._handoffs(session, a)
            objective = workflow.objective
            team = [(m.name, m.role, m.seniority) for m in members]
            team_ids = {m.name.lower(): m.id for m in members}
            names = {m.id: m.name for m in members}
            dept_name = department.name
        for h, dep_key in handoffs:
            await self._event(
                workflow_id,
                "handoff",
                f"{h.department} handed “{h.title}” to {dept_name}.",
                task_id=assignment_id,
                from_department=dep_key,
                to_department=a.department,
            )

        planned: list[tuple[str, str, str]]  # title, instructions, assignee id
        approach = ""
        if len(members) == 1:
            planned = [(a.title, a.description, lead.id)]
            approach = f"{lead.name} is the only available member and takes it on directly."
        else:
            base = prompts.breakdown_prompt(
                objective, dept_name, a.title, a.description, team, [h for h, _ in handoffs]
            )

            async def attempt(previous_error: str | None) -> tuple[plans.Breakdown, list[str]]:
                prompt = (
                    base
                    if not previous_error
                    else f"{base}\n\nYour previous reply could not be used: {previous_error} Reply again with valid JSON only."
                )
                text = await self._ask(
                    workflow_id,
                    assignment_id,
                    lead,
                    "workflow_breakdown",
                    prompt,
                    EmployeeStatus.WORKING.value,
                    f"Planning: {a.title}",
                    MAX_TOKENS["breakdown"],
                    screen=Screen("breakdown", f"Splitting up: {a.title}", brief=a.description),
                )
                return plans.parse_breakdown(text, team_ids)

            try:
                breakdown, assignees = await self._attempts(
                    workflow_id, assignment_id, "Task breakdown", attempt
                )
                planned = [
                    (t.title, t.instructions, eid)
                    for t, eid in zip(breakdown.tasks, assignees, strict=True)
                ]
                approach = breakdown.approach
            except _StepFailed as failed:
                planned = [(a.title, a.description, lead.id)]
                await self._event(
                    workflow_id,
                    "retry",
                    f"{lead.name}'s task breakdown could not be used ({failed}); {lead.name} will do the assignment directly.",
                    task_id=assignment_id,
                    actor=lead,
                )

        async with self.database.sessionmaker() as session:
            a = await session.get(Task, assignment_id)
            if a is None or a.status != TaskStatus.PLANNING:
                return
            created = []
            for position, (title, instructions, eid) in enumerate(planned):
                task = Task(
                    id=new_id("tsk"),
                    title=title,
                    description=instructions,
                    department=a.department,
                    assignee_id=eid,
                    status=TaskStatus.QUEUED.value,
                    kind="work",
                    workflow_id=workflow_id,
                    parent_id=a.id,
                    depends_on=[],
                    position=position,
                )
                session.add(task)
                created.append(task)
            a.status = TaskStatus.ACTIVE.value
            await session.commit()
        if approach:
            await self._event(
                workflow_id,
                "breakdown",
                f"{lead.name}: {approach}",
                task_id=assignment_id,
                actor=lead,
            )
        for task in created:
            who = names.get(task.assignee_id or "", "a team member")
            text = (
                f"{lead.name} took on “{task.title}”."
                if task.assignee_id == lead.id
                else f"{lead.name} assigned “{task.title}” to {who}."
            )
            await self._event(workflow_id, "assigned", text, task_id=task.id, actor=lead)
            await self._publish_task(task)
        await self._publish_task(a)
        await self._publish(workflow_id)
        await self._refresh_people(workflow_id)

    async def _work(self, workflow_id: str, task_id: str) -> None:
        async with self.database.sessionmaker() as session:
            workflow = await self._get(session, workflow_id)
            task = await session.get(Task, task_id)
            if task is None or task.status != TaskStatus.RUNNING:
                return
            a = await session.get(Task, task.parent_id) if task.parent_id else None
            department = await session.get(Department, task.department)
            members = await available_members(session, task.department)
            worker = next((m for m in members if m.id == task.assignee_id), None)
            if worker is None:
                # Suspended or removed since: the department lead takes over.
                worker = lead_of(department, members) if department else None
                if worker is None:
                    await self._finish_task(
                        task_id,
                        TaskStatus.FAILED,
                        error="Nobody in the department is available.",
                        expect=TaskStatus.RUNNING,
                    )
                    return
                task.assignee_id = worker.id
                await session.commit()
                await self._event(
                    workflow_id,
                    "reassigned",
                    f"“{task.title}” was reassigned to {worker.name} (the original assignee is unavailable).",
                    task_id=task_id,
                    actor=worker,
                )
            handoffs = [h for h, _ in await self._handoffs(session, a)] if a else []
            base = prompts.work_prompt(
                workflow.objective,
                department.name if department else task.department,
                a.title if a else task.title,
                task.title,
                task.description,
                handoffs,
                task.result if task.revisions else None,
                task.review_notes if task.revisions else None,
            )
            reviewer = lead_of(department, members) if department else None

        async def attempt(_: str | None) -> str:
            return await self._ask_text(
                workflow_id,
                task_id,
                worker,
                "workflow_work",
                base,
                EmployeeStatus.WORKING.value,
                f"Working on: {task.title}",
                MAX_TOKENS["work"],
                screen=Screen(
                    "work",
                    task.title,
                    brief=(
                        f"Revision requested: {task.review_notes}\n\n{task.description}"
                        if task.revisions and task.review_notes
                        else task.description
                    ),
                ),
            )

        try:
            result = await self._attempts(workflow_id, task_id, task.title, attempt)
        except _StepFailed as failed:
            await self._finish_task(
                task_id, TaskStatus.FAILED, error=str(failed), expect=TaskStatus.RUNNING
            )
            await self._event(
                workflow_id,
                "failed",
                f"“{task.title}” failed: {failed}",
                task_id=task_id,
                actor=worker,
            )
            await self.activity.flash(
                worker.id, EmployeeStatus.ERROR.value, f"Failed: {task.title}"
            )
            return

        self_review = reviewer is None or reviewer.id == worker.id
        async with self.database.sessionmaker() as session:
            task = await session.get(Task, task_id)
            if task is None or task.status != TaskStatus.RUNNING:
                return
            task.result = result
            if self_review:
                task.status = TaskStatus.DONE.value
                task.finished_at = now()
            else:
                task.status = TaskStatus.AWAITING_REVIEW.value
            await session.commit()
            await self._publish_task(task)
        if self_review:
            await self._register_task_artifact(task_id)
        verb = "revised" if task.revisions else "delivered"
        await self._event(
            workflow_id,
            "delivered",
            f"{worker.name} {verb} “{task.title}”."
            + (" (No separate reviewer in this department.)" if self_review else ""),
            task_id=task_id,
            actor=worker,
        )
        if self_review:
            await self.activity.flash(
                worker.id, EmployeeStatus.COMPLETED.value, f"Finished: {task.title}"
            )
        await self._publish(workflow_id)

    async def _review(self, workflow_id: str, task_id: str) -> None:
        async with self.database.sessionmaker() as session:
            task = await session.get(Task, task_id)
            if task is None or task.status != TaskStatus.REVIEWING:
                return
            department = await session.get(Department, task.department)
            members = await available_members(session, task.department)
            reviewer = lead_of(department, members) if department else None
            worker = await session.get(Employee, task.assignee_id) if task.assignee_id else None
            worker_name = worker.name if worker else "a team member"
            prompt = prompts.review_prompt(
                task.title, task.description, worker_name, task.result or ""
            )
            revisions = task.revisions
        if reviewer is None or (worker and reviewer.id == worker.id):
            await self._finish_task(task_id, TaskStatus.DONE, expect=TaskStatus.REVIEWING)
            return

        async def attempt(previous_error: str | None) -> plans.Review:
            p = (
                prompt
                if not previous_error
                else f"{prompt}\n\nYour previous reply could not be used: {previous_error} Reply again with valid JSON only."
            )
            text = await self._ask(
                workflow_id,
                task_id,
                reviewer,
                "workflow_review",
                p,
                EmployeeStatus.REVIEWING.value,
                f"Reviewing: {task.title}",
                MAX_TOKENS["review"],
                screen=Screen(
                    "review", f"Reviewing {worker_name}: {task.title}", brief=task.result or ""
                ),
            )
            return plans.parse_review(text)

        try:
            review = await self._attempts(
                workflow_id, task_id, f"Review of {task.title}", attempt, count=False
            )
        except _StepFailed as failed:
            await self._finish_task(
                task_id,
                TaskStatus.DONE,
                review_notes=f"Not reviewed: {failed}",
                expect=TaskStatus.REVIEWING,
            )
            await self._event(
                workflow_id,
                "review_failed",
                f"{reviewer.name} could not review “{task.title}” ({failed}); it was accepted without review.",
                task_id=task_id,
                actor=reviewer,
            )
            return

        if review.decision == "revise" and revisions < MAX_REVISIONS:
            async with self.database.sessionmaker() as session:
                task = await session.get(Task, task_id)
                if task is None or task.status != TaskStatus.REVIEWING:
                    return
                task.revisions += 1
                task.review_notes = review.feedback
                task.status = TaskStatus.QUEUED.value
                await session.commit()
                await self._publish_task(task)
            await self._event(
                workflow_id,
                "revision_requested",
                f"{reviewer.name} asked {worker_name} to revise “{task.title}”: {review.feedback}",
                task_id=task_id,
                actor=reviewer,
            )
        else:
            note = review.feedback
            if review.decision == "revise":
                note = f"Accepted after the maximum of {MAX_REVISIONS} revision. Remaining note: {review.feedback}"
            await self._finish_task(
                task_id, TaskStatus.DONE, review_notes=note, expect=TaskStatus.REVIEWING
            )
            await self._event(
                workflow_id,
                "approved_work",
                f"{reviewer.name} approved “{task.title}”."
                + (
                    f" {review.feedback}"
                    if review.feedback and review.decision == "approve"
                    else ""
                ),
                task_id=task_id,
                actor=reviewer,
            )
            if worker:
                await self.activity.flash(
                    worker.id, EmployeeStatus.COMPLETED.value, f"Finished: {task.title}"
                )
        await self._publish(workflow_id)

    async def _summary(self, workflow_id: str, assignment_id: str) -> None:
        async with self.database.sessionmaker() as session:
            workflow = await self._get(session, workflow_id)
            a = await session.get(Task, assignment_id)
            if a is None or a.status != TaskStatus.SUMMARIZING:
                return
            department = await session.get(Department, a.department)
            lead = (
                lead_of(department, await available_members(session, a.department))
                if department
                else None
            )
            results = []
            for w in await self._tasks(session, workflow_id, "work"):
                if w.parent_id == a.id and w.status == TaskStatus.DONE:
                    who = await session.get(Employee, w.assignee_id) if w.assignee_id else None
                    results.append((w.title, who.name if who else "a team member", w.result or ""))
            prompt = prompts.summary_prompt(workflow.objective, a.title, a.description, results)
        fallback = "\n\n".join(f"### {t} ({who})\n\n{r}" for t, who, r in results)
        if lead is None:
            await self._finish_task(
                assignment_id, TaskStatus.DONE, result=fallback, expect=TaskStatus.SUMMARIZING
            )
            return

        async def attempt(_: str | None) -> str:
            return await self._ask_text(
                workflow_id,
                assignment_id,
                lead,
                "workflow_summary",
                prompt,
                EmployeeStatus.WORKING.value,
                f"Summarising: {a.title}",
                MAX_TOKENS["summary"],
                screen=Screen(
                    "summary",
                    f"Department result: {a.title}",
                    brief="\n".join(f"• {t} — {who}" for t, who, _ in results),
                ),
            )

        try:
            result = await self._attempts(
                workflow_id, assignment_id, f"Summary of {a.title}", attempt, count=False
            )
        except _StepFailed as failed:
            await self._finish_task(
                assignment_id, TaskStatus.DONE, result=fallback, expect=TaskStatus.SUMMARIZING
            )
            await self._event(
                workflow_id,
                "summary_failed",
                f"{lead.name} could not write the summary ({failed}); the team's approved results are used as they are.",
                task_id=assignment_id,
                actor=lead,
            )
            return
        await self._finish_task(
            assignment_id, TaskStatus.DONE, result=result, expect=TaskStatus.SUMMARIZING
        )
        await self._event(
            workflow_id,
            "department_done",
            f"{lead.name} delivered {department.name if department else a.department}'s result for “{a.title}”.",
            task_id=assignment_id,
            actor=lead,
        )
        await self.activity.flash(lead.id, EmployeeStatus.COMPLETED.value, f"Finished: {a.title}")

    async def _consolidate(self, workflow_id: str) -> None:
        async with self.database.sessionmaker() as session:
            workflow = await self._get(session, workflow_id)
            if workflow.status != WorkflowStatus.CONSOLIDATING:
                return
            ceo = await available_ceo(session)
            departments = {d.key: d.name for d in await session.scalars(select(Department))}
            assignments = await self._tasks(session, workflow_id, "assignment")
            done = [
                (departments.get(a.department, a.department), a.title, a.result or "")
                for a in assignments
                if a.status == TaskStatus.DONE
            ]
            missing = [
                (departments.get(a.department, a.department), a.title, a.error or a.status)
                for a in assignments
                if a.status in (TaskStatus.FAILED, TaskStatus.SKIPPED)
            ]
            plan = workflow.plan or {}
            report_title, report_brief = workflow.title, workflow.objective
            prompt = prompts.consolidate_prompt(
                workflow.objective,
                plan.get("summary", ""),
                plan.get("deliverable", ""),
                done,
                missing,
            )
        if not done:
            await self._fail(
                workflow_id, "No department produced a result, so there is nothing to consolidate."
            )
            return
        if ceo is None:
            await self._fail(
                workflow_id,
                "The CEO is unavailable (suspended), so the report can't be consolidated.",
            )
            return

        async def attempt(_: str | None) -> str:
            return await self._ask_text(
                workflow_id,
                None,
                ceo,
                "workflow_report",
                prompt,
                EmployeeStatus.WORKING.value,
                "Consolidating the final report",
                MAX_TOKENS["report"],
                screen=Screen("report", f"Final report: {report_title}", brief=report_brief),
            )

        try:
            report = await self._attempts(workflow_id, None, "Final report", attempt)
        except _StepFailed as failed:
            await self._fail(
                workflow_id,
                f"The CEO could not consolidate the report: {failed}. The department results are kept; press Resume to try again.",
            )
            return

        run = self.runs.get(workflow_id)
        source_task: Task | None = None
        async with self.database.sessionmaker() as session:
            workflow = await self._get(session, workflow_id)
            if workflow.status != WorkflowStatus.CONSOLIDATING:
                return
            workflow.result = report
            workflow.status = (
                WorkflowStatus.COMPLETED_WITH_FAILURES if missing else WorkflowStatus.COMPLETED
            ).value
            workflow.status_reason = (
                f"{len(missing)} assignment(s) did not complete." if missing else None
            )
            workflow.finished_at = now()
            if workflow.source_task_id:
                source_task = await session.get(Task, workflow.source_task_id)
                if source_task is not None and source_task.kind == "manual":
                    source_task.status = TaskStatus.DONE.value
                    source_task.finished_at = now()
            report_message = Message(
                conversation_id=workflow.source_conversation_id,
                role=MessageRole.AGENT.value,
                employee_id=ceo.id,
                author_name=ceo.name,
                author_role=ceo.role,
                author_department=ceo.department,
                content=f"**Final report — {workflow.title}**\n\n{report}",
                status=MessageStatus.COMPLETE.value,
                model=run.last_model if run else None,
                model_source="workflow",
                finished_at=now(),
            )
            await self._commit_with(
                session,
                workflow,
                "completed",
                f"{ceo.name} delivered the final report."
                + (
                    f" {len(missing)} assignment(s) did not complete and are listed in it."
                    if missing
                    else ""
                ),
                actor=ceo,
                messages=[report_message],
            )
        await self._register_workflow_artifact(workflow_id)
        if source_task is not None:
            await self._register_task_artifact(source_task.id)
            await self._publish_task(source_task)
        await self.activity.flash(
            ceo.id, EmployeeStatus.COMPLETED.value, "Delivered the final report"
        )
        await self._publish(workflow_id)
        await self._refresh_people(workflow_id)

    # ================================================================= helpers

    async def _attempts[T](
        self,
        workflow_id: str,
        task_id: str | None,
        label: str,
        attempt: Callable[[str | None], Awaitable[T]],
        *,
        count: bool = True,
    ) -> T:
        """The retry policy: transient errors and unusable replies get one more try;
        refusals that need the owner pause the workflow; anything else fails the step.
        `count`: record attempts on the task (its own work, not reviews or summaries)."""
        previous: str | None = None
        for number in range(1, MAX_ATTEMPTS + 1):
            if count:
                await self._count_attempt(workflow_id, task_id)
            try:
                return await attempt(previous)
            except GatewayError as error:
                if error.kind in PAUSE_KINDS:
                    raise _Pause(str(error)) from error
                previous = str(error)
                if error.kind not in RETRY_KINDS or number == MAX_ATTEMPTS:
                    raise _StepFailed(previous) from error
            except plans.PlanError as error:
                previous = str(error)
                if number == MAX_ATTEMPTS:
                    raise _StepFailed(f"unusable reply — {previous}") from error
            await self._event(
                workflow_id,
                "retry",
                f"{label}: {previous} Retrying (attempt {number + 1} of {MAX_ATTEMPTS}).",
                task_id=task_id,
            )
        raise _StepFailed(previous or "failed")  # pragma: no cover - loop always returns or raises

    async def _count_attempt(self, workflow_id: str, task_id: str | None) -> None:
        async with self.database.sessionmaker() as session:
            if task_id:
                task = await session.get(Task, task_id)
                if task:
                    task.attempts += 1
            else:
                workflow = await session.get(Workflow, workflow_id)
                if workflow:
                    workflow.plan_attempts += 1
            await session.commit()

    async def _ask(
        self,
        workflow_id: str,
        task_id: str | None,
        employee: Employee,
        purpose: str,
        prompt: str,
        status: str,
        detail: str,
        max_tokens: int,
        screen: Screen | None = None,
    ) -> str:
        run = self.runs[workflow_id]
        async with run.calls_lock, self.database.sessionmaker() as session:
            workflow = await self._get(session, workflow_id)
            if workflow.calls_used >= workflow.max_calls:
                raise _LimitReached
            workflow.calls_used += 1
            await session.commit()
        # Streamed, so the employee's monitor shows the text as it is written.
        token = await self.activity.begin(employee.id, status, detail, screen)
        completion = None
        written = ""
        events = None
        try:
            async with self.database.sessionmaker() as session:
                _, events = await self.gateway.stream(
                    session,
                    [{"role": "user", "content": prompt}],
                    employee_id=employee.id,
                    purpose=purpose,
                    context=prompts.RULES,
                    max_tokens=max_tokens,
                )
            async for event in events:
                if event.kind == "reasoning":
                    self.activity.update_screen(employee.id, token, thinking=True)
                elif event.kind == "text" and event.text:
                    written += event.text
                    self.activity.update_screen(employee.id, token, text=written)
                elif event.kind == "done":
                    completion = event.completion
        finally:
            if events is not None:
                await events.aclose()  # type: ignore[attr-defined]
            await self.activity.end(employee.id, token, screen_failed=completion is None)
        if completion is None:
            raise GatewayError("provider_unavailable", "The reply stream ended unexpectedly.")
        async with self.database.sessionmaker() as session:
            workflow = await session.get(Workflow, workflow_id)
            if workflow:
                workflow.prompt_tokens += completion.prompt_tokens or 0
                workflow.completion_tokens += completion.completion_tokens or 0
            if task_id:
                task = await session.get(Task, task_id)
                if task:
                    task.calls += 1
                    task.prompt_tokens += completion.prompt_tokens or 0
                    task.completion_tokens += completion.completion_tokens or 0
            await session.commit()
        await self._publish(workflow_id)
        text = (completion.content or "").strip()
        if not text:
            raise GatewayError(
                "empty",
                "The model returned no visible text (its reasoning used the output tokens).",
            )
        run.last_model = completion.model
        return text

    async def _ask_text(self, *args: Any, **kwargs: Any) -> str:
        """A free-text deliverable (format echoes removed; empty counts as a failure)."""
        text = prompts.clean_text(await self._ask(*args, **kwargs))
        if not text:
            raise GatewayError("empty", "The model returned only the format line, no content.")
        return text

    async def _handoffs(
        self, session: AsyncSession, assignment: Task | None
    ) -> list[tuple[prompts.Handoff, str]]:
        """Results of the assignments this one depends on (interdepartment hand-offs)."""
        if assignment is None or not assignment.depends_on:
            return []
        out = []
        for dep_id in assignment.depends_on:
            dep = await session.get(Task, dep_id)
            if dep is None or dep.status != TaskStatus.DONE or not dep.result:
                continue
            department = await session.get(Department, dep.department)
            lead = await session.get(Employee, dep.assignee_id) if dep.assignee_id else None
            out.append(
                (
                    prompts.Handoff(
                        department.name if department else dep.department,
                        lead.name if lead else "the department",
                        dep.title,
                        dep.result,
                    ),
                    dep.department,
                )
            )
        return out

    async def _finish_task(
        self,
        task_id: str,
        status: TaskStatus,
        *,
        expect: TaskStatus,
        error: str | None = None,
        result: str | None = None,
        review_notes: str | None = None,
    ) -> None:
        async with self.database.sessionmaker() as session:
            task = await session.get(Task, task_id)
            if task is None or task.status != expect:
                return  # cancelled or changed meanwhile
            task.status = status.value
            task.finished_at = now()
            if error is not None:
                task.error = error
            if result is not None:
                task.result = result
            if review_notes is not None:
                task.review_notes = review_notes
            await session.commit()
            await self._publish_task(task)
        if status == TaskStatus.DONE and (result or task.result):
            await self._register_task_artifact(task_id)

    async def _register_task_artifact(self, task_id: str) -> None:
        if not self.artifacts:
            return
        try:
            await self.artifacts.register_task(task_id)
        except Exception:
            log.exception("workflow.task_artifact_registration_failed", task_id=task_id)

    async def _register_workflow_artifact(self, workflow_id: str) -> None:
        if not self.artifacts:
            return
        try:
            await self.artifacts.register_workflow(workflow_id)
        except Exception:
            log.exception("workflow.artifact_registration_failed", workflow_id=workflow_id)

    async def _revert(self, workflow_id: str, key: str) -> None:
        """A paused step goes back to waiting so Resume can redo it."""
        kind, _, task_id = key.partition(":")
        back = {
            "work": (TaskStatus.RUNNING, TaskStatus.QUEUED),
            "review": (TaskStatus.REVIEWING, TaskStatus.AWAITING_REVIEW),
            "breakdown": (TaskStatus.PLANNING, TaskStatus.QUEUED),
            "summary": (TaskStatus.SUMMARIZING, TaskStatus.ACTIVE),
        }.get(kind)
        if not back or not task_id:
            return
        async with self.database.sessionmaker() as session:
            task = await session.get(Task, task_id)
            if task and task.status == back[0]:
                task.status = back[1].value
                await session.commit()
                await self._publish_task(task)

    async def _pause(self, workflow_id: str, reason: str) -> None:
        async with self.database.sessionmaker() as session:
            workflow = await session.get(Workflow, workflow_id)
            if workflow is None or workflow.status not in ACTIVE:
                return
            workflow.status = WorkflowStatus.PAUSED.value
            workflow.status_reason = f"Paused: {reason} Press Resume when this is resolved."
            await self._commit_with(
                session,
                workflow,
                "paused",
                f"Paused: {reason}",
                messages=[self._notice(workflow, f"Workflow paused: {reason}")],
            )
        await self._publish(workflow_id)
        await self._refresh_people(workflow_id)

    async def _fail(self, workflow_id: str, reason: str) -> None:
        async with self.database.sessionmaker() as session:
            workflow = await session.get(Workflow, workflow_id)
            if workflow is None or workflow.status in FINISHED:
                return
            workflow.status = WorkflowStatus.FAILED.value
            workflow.status_reason = reason
            workflow.finished_at = now()
            await self._commit_with(
                session,
                workflow,
                "workflow_failed",
                reason,
                messages=[self._notice(workflow, f"Workflow failed: {reason}")],
            )
        self._stop_other_steps(workflow_id)
        await self._publish(workflow_id)
        await self._refresh_people(workflow_id)

    def _stop_other_steps(self, workflow_id: str) -> None:
        run = self.runs.get(workflow_id)
        current = asyncio.current_task()
        if run:
            for step in run.steps.values():
                if step is not current:
                    step.cancel()

    async def _close_open_tasks(
        self, session: AsyncSession, workflow_id: str, status: TaskStatus, reason: str
    ) -> list[Task]:
        changed = []
        for task in await self._tasks(session, workflow_id):
            if task.status not in TERMINAL:
                task.status = status.value
                task.error = reason
                task.finished_at = now()
                changed.append(task)
        return changed

    async def _get(self, session: AsyncSession, workflow_id: str) -> Workflow:
        workflow = await session.get(Workflow, workflow_id)
        if workflow is None:
            raise WorkflowError("Workflow not found.", 404)
        return workflow

    async def _tasks(
        self, session: AsyncSession, workflow_id: str, kind: str | None = None
    ) -> list[Task]:
        query = select(Task).where(Task.workflow_id == workflow_id)
        if kind:
            query = query.where(Task.kind == kind)
        return list(await session.scalars(query.order_by(Task.position, Task.created_at)))

    async def _refresh_people(self, workflow_id: str) -> None:
        async with self.database.sessionmaker() as session:
            ids = {t.assignee_id for t in await self._tasks(session, workflow_id) if t.assignee_id}
            workflow = await session.get(Workflow, workflow_id)
            if workflow and workflow.ceo_id:
                ids.add(workflow.ceo_id)
        await self.activity.refresh_many(ids)

    async def _commit_with(
        self,
        session: AsyncSession,
        workflow: Workflow,
        kind: str,
        text: str,
        *,
        actor: Employee | None = None,
        messages: list[Message] | None = None,
    ) -> None:
        """Commits a status change together with its timeline event and any chat
        messages, so no one ever sees one without the others."""
        event = WorkflowEvent(
            workflow_id=workflow.id,
            kind=kind,
            actor_id=actor.id if actor else None,
            actor_name=actor.name if actor else None,
            text=text[:4000],
        )
        session.add(event)
        conversation = None
        if messages and workflow.source_conversation_id:
            from app.models import Conversation

            conversation = await session.get(Conversation, workflow.source_conversation_id)
            if conversation is not None:
                for message in messages:
                    session.add(message)
                conversation.last_message_at = now()
        await session.commit()
        await session.refresh(event)
        self.events.publish("workflow.event", event_out(event))
        log.info("workflow.event", workflow_id=workflow.id, kind=kind)
        if conversation is not None and messages and self.chat is not None:
            for message in messages:
                await session.refresh(message)
                await self.chat.publish_message(session, message, "message.created")
            await self.chat._publish_conversation(session, conversation)

    def _notice(self, workflow: Workflow, text: str) -> Message:
        """A system notice for the source conversation (never a model's words)."""
        return Message(
            conversation_id=workflow.source_conversation_id,
            role=MessageRole.SYSTEM.value,
            content=f"{text} [Open workflow](/workflows/{workflow.id})",
            status=MessageStatus.COMPLETE.value,
            finished_at=now(),
        )

    # ---------------------------------------------------------- notifications

    async def _event(
        self,
        workflow_id: str,
        kind: str,
        text: str,
        *,
        task_id: str | None = None,
        actor: Employee | None = None,
        from_department: str | None = None,
        to_department: str | None = None,
    ) -> None:
        async with self.database.sessionmaker() as session:
            event = WorkflowEvent(
                workflow_id=workflow_id,
                task_id=task_id,
                kind=kind,
                actor_id=actor.id if actor else None,
                actor_name=actor.name if actor else None,
                from_department=from_department,
                to_department=to_department,
                text=text[:4000],
            )
            session.add(event)
            await session.commit()
            await session.refresh(event)
            self.events.publish("workflow.event", event_out(event))
        log.info("workflow.event", workflow_id=workflow_id, kind=kind)

    async def _publish_task(self, task: Task) -> None:
        """Re-reads the task (server-set timestamps) before announcing it."""
        async with self.database.sessionmaker() as session:
            fresh = await session.get(Task, task.id)
            if fresh is not None:
                self.events.publish("task.updated", dump(TaskOut.model_validate(fresh)))

    async def _publish(self, workflow_id: str) -> None:
        async with self.database.sessionmaker() as session:
            workflow = await session.get(Workflow, workflow_id)
            if workflow is not None:
                self.events.publish(
                    "workflow.updated", await workflow_summary(session, workflow, self)
                )


# =================================================================== output


def event_out(event: WorkflowEvent) -> dict[str, Any]:
    return {
        "id": event.id,
        "workflow_id": event.workflow_id,
        "task_id": event.task_id,
        "created_at": event.created_at.isoformat() if event.created_at else now().isoformat(),
        "kind": event.kind,
        "actor_id": event.actor_id,
        "actor_name": event.actor_name,
        "from_department": event.from_department,
        "to_department": event.to_department,
        "text": event.text,
    }


async def workflow_summary(
    session: AsyncSession, workflow: Workflow, engine: Orchestrator | None = None
) -> dict[str, Any]:
    tasks = list(await session.scalars(select(Task).where(Task.workflow_id == workflow.id)))
    counts: dict[str, int] = {}
    for t in tasks:
        if t.kind == "work":
            counts[t.status] = counts.get(t.status, 0) + 1
    assignments = [t for t in tasks if t.kind == "assignment"]
    run = engine.runs.get(workflow.id) if engine else None
    return {
        "id": workflow.id,
        "title": workflow.title,
        "objective": workflow.objective,
        "status": workflow.status,
        "status_reason": workflow.status_reason,
        "ceo_id": workflow.ceo_id,
        "departments": [
            a.department
            for a in sorted(assignments, key=lambda t: t.position)
            if a.status != TaskStatus.CANCELLED or workflow.approved_at is None
        ],
        "assignments": {
            "total": len(assignments),
            "done": sum(a.status == TaskStatus.DONE for a in assignments),
            "failed": sum(a.status in (TaskStatus.FAILED, TaskStatus.SKIPPED) for a in assignments),
        },
        "work": counts,
        "calls_used": workflow.calls_used,
        "max_calls": workflow.max_calls,
        "prompt_tokens": workflow.prompt_tokens,
        "completion_tokens": workflow.completion_tokens,
        "steps_in_flight": len(run.steps) if run else 0,
        "source_conversation_id": workflow.source_conversation_id,
        "source_task_id": workflow.source_task_id,
        "created_at": workflow.created_at.isoformat() if workflow.created_at else None,
        "approved_at": workflow.approved_at.isoformat() if workflow.approved_at else None,
        "finished_at": workflow.finished_at.isoformat() if workflow.finished_at else None,
    }


def estimate_calls(assignments: list[Task], team_sizes: dict[str, int]) -> dict[str, int]:
    """Model requests still needed after approval: typical and worst case (within limits)."""
    typical = worst = 1  # the CEO's final report
    for a in assignments:
        size = team_sizes.get(a.department, 1)
        if size <= 1:
            typical += 1
            worst += MAX_ATTEMPTS
            continue
        tasks = min(plans.MAX_TASKS_PER_ASSIGNMENT, size)
        typical += 1 + 2 * tasks + (1 if tasks > 1 else 0)
        worst += MAX_ATTEMPTS * (1 + tasks * 2 * (1 + MAX_REVISIONS) + 1)
    return {"typical": typical, "worst": worst}
