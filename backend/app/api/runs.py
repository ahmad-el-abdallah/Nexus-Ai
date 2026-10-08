"""Running employee-written code in the sandbox, after the owner approves it."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.models import CodeRun
from app.sandbox.service import RunError, RunService, run_out

router = APIRouter(prefix="/api/runs", tags=["sandbox"])
Session = Annotated[AsyncSession, Depends(get_session)]


def service(request: Request) -> RunService:
    return request.app.state.runs


Runs = Annotated[RunService, Depends(service)]


class RunCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(min_length=1, max_length=100_000)
    language: str = Field(max_length=20)
    message_id: int | None = None
    task_id: str | None = None


class Approval(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code_sha256: str = Field(min_length=64, max_length=64)


def _error(error: RunError) -> HTTPException:
    return HTTPException(error.status, str(error))


@router.get("/capabilities")
async def capabilities(runs: Runs) -> dict[str, Any]:
    return runs.capabilities()


@router.get("")
async def list_runs(
    session: Session, message_id: int | None = None, task_id: str | None = None
) -> list[dict[str, Any]]:
    query = select(CodeRun)
    if message_id is not None:
        query = query.where(CodeRun.message_id == message_id)
    if task_id is not None:
        query = query.where(CodeRun.task_id == task_id)
    rows = await session.scalars(query.order_by(CodeRun.created_at.desc()).limit(100))
    return [run_out(r) for r in rows]


@router.post("", status_code=201)
async def create_run(body: RunCreate, session: Session, runs: Runs) -> dict[str, Any]:
    """Prepares a run of code from an employee's reply or task result; nothing runs yet."""
    try:
        run = await runs.create(session, body.code, body.language, body.message_id, body.task_id)
    except RunError as error:
        raise _error(error) from error
    return run_out(run)


@router.post("/{run_id}/approve")
async def approve(run_id: str, body: Approval, session: Session, runs: Runs) -> dict[str, Any]:
    """The owner approves this exact code (by its SHA-256); it runs in the sandbox."""
    try:
        return run_out(await runs.approve(session, run_id, body.code_sha256))
    except RunError as error:
        raise _error(error) from error


@router.post("/{run_id}/reject")
async def reject(run_id: str, session: Session, runs: Runs) -> dict[str, Any]:
    try:
        return run_out(await runs.reject(session, run_id))
    except RunError as error:
        raise _error(error) from error


@router.get("/{run_id}")
async def get_run(run_id: str, session: Session) -> dict[str, Any]:
    run = await session.get(CodeRun, run_id)
    if run is None:
        raise HTTPException(404, "Run not found")
    return run_out(run)


@router.get("/{run_id}/files/{name}")
async def download(run_id: str, name: str, session: Session, runs: Runs) -> FileResponse:
    """A file the code wrote — always downloaded, never displayed in the page."""
    run = await session.get(CodeRun, run_id)
    if run is None or not any(f["name"] == name for f in run.files):
        raise HTTPException(404, "File not found")
    path = runs.files_dir(run_id) / name
    if not path.is_file() or path.resolve().parent != runs.files_dir(run_id).resolve():
        raise HTTPException(404, "File not found")
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=name,
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"},
    )
