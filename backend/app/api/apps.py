"""Apps: the owner asks engineering for a web application, approves the design, then
downloads it, runs it in the sandbox or asks for changes."""

from __future__ import annotations

import re
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.apps.builder import (
    DEFAULT_MAX_CALLS,
    AppBuilder,
    app_summary,
    estimate_calls,
    event_out,
    file_out,
    known_issues,
    latest_version,
    version_files,
    version_out,
    written_tree,
)
from app.apps.errors import AppError
from app.apps.files import zip_bytes
from app.apps.runtime import AppRuntime, run_out
from app.apps.stacks import STACKS, dependencies
from app.db.session import get_session
from app.models import (
    App,
    AppEvent,
    AppRun,
    AppStatus,
    AppVersion,
    Conversation,
    Employee,
    Message,
    MessageRole,
)

router = APIRouter(prefix="/api/apps", tags=["apps"])
Session = Annotated[AsyncSession, Depends(get_session)]


def _builder(request: Request) -> AppBuilder:
    return request.app.state.apps


def _runtime(request: Request) -> AppRuntime:
    return request.app.state.app_runtime


Builder = Annotated[AppBuilder, Depends(_builder)]
Runtime = Annotated[AppRuntime, Depends(_runtime)]


def _error(error: AppError) -> HTTPException:
    return HTTPException(error.status, str(error))


class AppCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    description: str | None = Field(default=None, max_length=8000)
    source_conversation_id: str | None = None
    source_message_id: int | None = None
    max_calls: int = Field(default=DEFAULT_MAX_CALLS, ge=8, le=120)


class ChangeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request: str = Field(min_length=5, max_length=8000)
    max_calls: int = Field(default=DEFAULT_MAX_CALLS, ge=8, le=120)


class RunApproval(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tree_sha256: str = Field(min_length=64, max_length=64)


async def _app(session: AsyncSession, app_id: str) -> App:
    app = await session.get(App, app_id, populate_existing=True)
    if app is None:
        raise HTTPException(404, "App not found")
    return app


async def _version(session: AsyncSession, app_id: str, number: int | None) -> AppVersion:
    await _app(session, app_id)
    version = await latest_version(session, app_id, number)
    if version is None:
        raise HTTPException(404, "Version not found")
    return version


async def _detail(
    session: AsyncSession, app: App, runtime: AppRuntime, number: int | None = None
) -> dict[str, Any]:
    summary = await app_summary(session, app)  # first: its status gates what follows
    versions = list(
        await session.scalars(
            select(AppVersion)
            .where(AppVersion.app_id == app.id)
            .order_by(AppVersion.number)
            .execution_options(populate_existing=True)
        )
    )
    current = next((v for v in versions if v.number == number), None) if number else None
    if current is None:
        if number is not None or not versions:
            raise HTTPException(404, "Version not found")
        current = versions[-1]
    files = await version_files(session, current.id)
    events = await session.scalars(
        select(AppEvent).where(AppEvent.app_id == app.id).order_by(AppEvent.id)
    )
    run = await session.scalar(
        select(AppRun)
        .where(AppRun.app_id == app.id)
        .order_by(AppRun.approved_at.desc())  # set in code: finer than the database clock
        .limit(1)
        .execution_options(populate_existing=True)
    )
    architect = await session.get(Employee, current.architect_id or "")
    stack = STACKS.get(current.stack or "")
    return {
        **summary,
        "versions": [version_out(v) for v in versions],
        "current": {
            **version_out(current),
            "plan": current.plan,
            "stack_name": stack.name if stack else None,
            "architect": (
                {"id": architect.id, "name": architect.name, "role": architect.role}
                if architect
                else None
            ),
            "files": [file_out(f) for f in files],
            "estimate": (
                estimate_calls(files, current)
                if current.status == AppStatus.AWAITING_APPROVAL
                else None
            ),
            "known_issues": known_issues(files),
            "dependencies": dependencies(written_tree(files)),
        },
        "events": [event_out(e) for e in events],
        "run": run_out(run) if run else None,
        "runtime": runtime.capabilities(),
    }


@router.get("")
async def list_apps(session: Session) -> list[dict[str, Any]]:
    apps = await session.scalars(select(App).order_by(App.created_at.desc()).limit(200))
    return [await app_summary(session, app) for app in apps]


@router.get("/runtime")
async def runtime_state(runtime: Runtime) -> dict[str, Any]:
    """Whether apps can be run here, the preview port, the limits and what is running."""
    return runtime.capabilities()


@router.post("", status_code=201)
async def create_app(
    body: AppCreate, session: Session, builder: Builder, runtime: Runtime
) -> dict[str, Any]:
    """Asks engineering for an app: the architect drafts a design for the owner to approve."""
    description = (body.description or "").strip()
    conversation_id = body.source_conversation_id
    if body.source_message_id is not None:
        message = await session.get(Message, body.source_message_id)
        if message is None or message.role != MessageRole.OWNER:
            raise HTTPException(404, "Owner message not found")
        conversation_id = message.conversation_id
        description = description or message.content.strip()
    if conversation_id and await session.get(Conversation, conversation_id) is None:
        raise HTTPException(404, "Conversation not found")
    if len(description) < 10:
        raise HTTPException(422, "Describe the app in at least a sentence.")
    try:
        app = await builder.create(
            session, description, conversation_id=conversation_id, max_calls=body.max_calls
        )
    except AppError as error:
        raise _error(error) from error
    return await _detail(session, app, runtime)


@router.get("/{app_id}")
async def get_app(
    app_id: str, session: Session, runtime: Runtime, version: int | None = None
) -> dict[str, Any]:
    return await _detail(session, await _app(session, app_id), runtime, version)


@router.post("/{app_id}/approve")
async def approve(
    app_id: str, session: Session, builder: Builder, runtime: Runtime
) -> dict[str, Any]:
    """Owner checkpoint: the files are written only after this call."""
    try:
        await builder.approve(session, app_id)
    except AppError as error:
        raise _error(error) from error
    return await _detail(session, await _app(session, app_id), runtime)


@router.post("/{app_id}/cancel")
async def cancel(
    app_id: str, session: Session, builder: Builder, runtime: Runtime
) -> dict[str, Any]:
    try:
        await builder.cancel(app_id)
    except AppError as error:
        raise _error(error) from error
    return await _detail(session, await _app(session, app_id), runtime)


@router.post("/{app_id}/resume")
async def resume(
    app_id: str, session: Session, builder: Builder, runtime: Runtime
) -> dict[str, Any]:
    try:
        await builder.resume(app_id)
    except AppError as error:
        raise _error(error) from error
    return await _detail(session, await _app(session, app_id), runtime)


@router.post("/{app_id}/changes", status_code=201)
async def request_change(
    app_id: str, body: ChangeRequest, session: Session, builder: Builder, runtime: Runtime
) -> dict[str, Any]:
    """Asks the team to change a finished app; the result is a new version."""
    try:
        app = await builder.request_change(session, app_id, body.request, body.max_calls)
    except AppError as error:
        raise _error(error) from error
    return await _detail(session, app, runtime)


@router.delete("/{app_id}", status_code=204)
async def delete_app(app_id: str, session: Session, builder: Builder, runtime: Runtime) -> None:
    """Deletes the app with all its versions, installed packages and stored data."""
    await _app(session, app_id)
    await runtime.remove(app_id)
    try:
        await builder.delete(session, app_id)
    except AppError as error:
        raise _error(error) from error


@router.get("/{app_id}/versions/{number}/file")
async def get_file(
    app_id: str, number: int, session: Session, path: Annotated[str, Query(max_length=200)]
) -> dict[str, Any]:
    """One file's content, as data — it is never served as a page."""
    version = await _version(session, app_id, number)
    file = next((f for f in await version_files(session, version.id) if f.path == path), None)
    if file is None:
        raise HTTPException(404, "File not found")
    return {**file_out(file), "content": file.content}


@router.get("/{app_id}/versions/{number}/download")
async def download(app_id: str, number: int, session: Session) -> Response:
    """The version's files as a zip — always a download."""
    app = await _app(session, app_id)
    version = await _version(session, app_id, number)
    files = written_tree(await version_files(session, version.id))
    if not files:
        raise HTTPException(409, "No file of this version has been written yet.")
    slug = re.sub(r"[^a-z0-9]+", "-", app.name.lower()).strip("-")[:40] or "app"
    name = f"{slug}-v{number}"
    return Response(
        zip_bytes(files, name),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{name}.zip"',
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
        },
    )


@router.post("/{app_id}/versions/{number}/run", status_code=201)
async def run_version(
    app_id: str, number: int, body: RunApproval, session: Session, runtime: Runtime
) -> dict[str, Any]:
    """The owner approves this exact version (by its hash); it is installed and started
    in the sandbox."""
    try:
        return run_out(await runtime.start(session, app_id, number, body.tree_sha256))
    except AppError as error:
        raise _error(error) from error


@router.post("/runs/{run_id}/stop")
async def stop_run(run_id: str, session: Session, runtime: Runtime) -> dict[str, Any]:
    try:
        await runtime.stop(run_id)
    except AppError as error:
        raise _error(error) from error
    run = await session.get(AppRun, run_id, populate_existing=True)
    if run is None:
        raise HTTPException(404, "Run not found")
    return run_out(run)
