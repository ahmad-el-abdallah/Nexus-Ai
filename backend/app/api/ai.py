"""Settings → AI providers → NVIDIA, the model catalogue, usage and a streaming playground."""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.gateway import AIGateway, GatewayError
from app.ai.provider import ProviderError
from app.ai.secrets import SecretStoreError, encrypt
from app.core.config import Settings
from app.core.logging import get_logger
from app.db.session import get_session
from app.models import AIModel, AIProviderSettings, AIUsage, Department, Employee

router = APIRouter(prefix="/api/ai", tags=["ai"])
log = get_logger("nexus.ai.api")
Session = Annotated[AsyncSession, Depends(get_session)]


def gateway(request: Request) -> AIGateway:
    return request.app.state.ai


Gateway = Annotated[AIGateway, Depends(gateway)]


def _error(error: GatewayError) -> HTTPException:
    return HTTPException(error.http_status, {"kind": error.kind, "message": str(error)})


# ----------------------------------------------------------------- settings


class KeyStatus(BaseModel):
    present: bool
    source: str | None  # "app" | "env" | None
    hint: str | None  # last 4 characters only
    updated_at: datetime | None
    can_save: bool  # NEXUS_SECRET_KEY available for encryption


class LastTest(BaseModel):
    at: datetime | None
    ok: bool | None
    message: str | None


class AISettingsOut(BaseModel):
    provider: str
    base_url: str
    default_model: str | None
    max_output_tokens: int
    temperature: float
    timeout_seconds: int
    concurrency_limit: int
    daily_request_budget: int
    paused: bool
    key: KeyStatus
    last_test: LastTest


class AISettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_url: str | None = Field(default=None, max_length=300)
    default_model: str | None = None
    max_output_tokens: int | None = Field(default=None, ge=16, le=16384)
    temperature: float | None = Field(default=None, ge=0, le=2)
    timeout_seconds: int | None = Field(default=None, ge=5, le=600)
    concurrency_limit: int | None = Field(default=None, ge=1, le=16)
    daily_request_budget: int | None = Field(default=None, ge=0, le=1_000_000)
    paused: bool | None = None


class KeyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    api_key: str = Field(min_length=20, max_length=400)


def _key_status(gw: AIGateway, cfg: AIProviderSettings) -> KeyStatus:
    try:
        key, source = gw.api_key(cfg)
    except SecretStoreError:
        key, source = None, "app"
    return KeyStatus(
        present=key is not None,
        source=source,
        hint=key[-4:] if key else None,
        updated_at=cfg.key_updated_at if source == "app" else None,
        can_save=gw.settings.secret_key is not None,
    )


def _settings_out(gw: AIGateway, cfg: AIProviderSettings) -> AISettingsOut:
    return AISettingsOut(
        provider=cfg.provider,
        base_url=cfg.base_url,
        default_model=cfg.default_model,
        max_output_tokens=cfg.max_output_tokens,
        temperature=cfg.temperature,
        timeout_seconds=cfg.timeout_seconds,
        concurrency_limit=cfg.concurrency_limit,
        daily_request_budget=cfg.daily_request_budget,
        paused=cfg.paused,
        key=_key_status(gw, cfg),
        last_test=LastTest(at=cfg.last_test_at, ok=cfg.last_test_ok, message=cfg.last_test_message),
    )


async def require_model(session: AsyncSession, model_id: str | None) -> None:
    """Routing may only point at models the provider actually lists."""
    if model_id is None:
        return
    row = await session.get(AIModel, model_id)
    if row is None or not row.listed:
        raise HTTPException(
            422,
            f"'{model_id}' isn't in the model catalogue. Refresh the model list in Settings → AI providers.",
        )


@router.get("/settings", response_model=AISettingsOut)
async def get_settings(session: Session, gw: Gateway) -> AISettingsOut:
    return _settings_out(gw, await gw.config(session))


@router.patch("/settings", response_model=AISettingsOut)
async def update_settings(patch: AISettingsPatch, session: Session, gw: Gateway) -> AISettingsOut:
    cfg = await gw.config(session)
    fields = patch.model_fields_set
    if "base_url" in fields and patch.base_url is not None:
        url = urlparse(patch.base_url)
        local = url.hostname in ("127.0.0.1", "localhost")
        if url.scheme != "https" and not (url.scheme == "http" and local):
            raise HTTPException(
                422, "The base URL must use https (http is allowed only for localhost)."
            )
        cfg.base_url = patch.base_url.rstrip("/")
    if "default_model" in fields:
        await require_model(session, patch.default_model)
        cfg.default_model = patch.default_model
    for name in (
        "max_output_tokens",
        "temperature",
        "timeout_seconds",
        "concurrency_limit",
        "daily_request_budget",
        "paused",
    ):
        if name in fields and getattr(patch, name) is not None:
            setattr(cfg, name, getattr(patch, name))
    await session.commit()
    await session.refresh(cfg)
    if "paused" in fields:
        log.warning("ai.emergency_stop", paused=cfg.paused)
    return _settings_out(gw, cfg)


@router.put("/key", response_model=AISettingsOut)
async def save_key(body: KeyIn, session: Session, gw: Gateway) -> AISettingsOut:
    key = body.api_key.strip()
    if any(c.isspace() for c in key):
        raise HTTPException(422, "The API key must not contain spaces.")
    cfg = await gw.config(session)
    try:
        cfg.encrypted_api_key = encrypt(gw.settings, key)
    except SecretStoreError as error:
        raise HTTPException(409, str(error)) from error
    cfg.key_updated_at = datetime.now(UTC)
    cfg.last_test_ok = None
    cfg.last_test_message = "Key changed — run a connection test."
    await session.commit()
    await session.refresh(cfg)
    log.info("ai.key_saved", source="app")
    return _settings_out(gw, cfg)


@router.delete("/key", response_model=AISettingsOut)
async def delete_key(session: Session, gw: Gateway) -> AISettingsOut:
    cfg = await gw.config(session)
    cfg.encrypted_api_key = None
    cfg.key_updated_at = None
    cfg.last_test_ok = None
    cfg.last_test_message = None
    await session.commit()
    await session.refresh(cfg)
    log.info("ai.key_removed")
    return _settings_out(gw, cfg)


# --------------------------------------------------------- connection test


class TestStep(BaseModel):
    name: str
    ok: bool
    ms: int | None = None
    detail: str


class TestResult(BaseModel):
    ok: bool
    steps: list[TestStep]


class TestIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: str | None = None


@router.post("/test", response_model=TestResult)
async def test_connection(body: TestIn, session: Session, gw: Gateway) -> TestResult:
    """Checks the key against the model list, then (if a model is chosen) one tiny completion."""
    cfg = await gw.config(session)
    steps: list[TestStep] = []
    try:
        provider = gw._provider(cfg)
        if cfg.paused:
            raise GatewayError("paused", "AI requests are paused by the emergency stop.", 423)
        started = time.perf_counter()
        try:
            models = await provider.list_models()
            steps.append(
                TestStep(
                    name="Authenticate & list models",
                    ok=True,
                    ms=int((time.perf_counter() - started) * 1000),
                    detail=f"{len(models)} models listed for this key",
                )
            )
        except ProviderError as error:
            steps.append(
                TestStep(
                    name="Authenticate & list models",
                    ok=False,
                    ms=int((time.perf_counter() - started) * 1000),
                    detail=str(error),
                )
            )
        model = body.model or cfg.default_model
        if steps[-1].ok and model:
            started = time.perf_counter()
            try:
                completion, _, stats = await gw.complete(
                    session,
                    [{"role": "user", "content": "Reply with the single word: ready"}],
                    model=model,
                    purpose="connection_test",
                    max_tokens=64,
                )
                text = completion.content.strip()
                detail = (
                    f"{model} replied “{text[:60]}”"
                    if text
                    else f"{model} answered but returned no visible text (reasoning used the tokens)"
                )
                if stats.retries:
                    detail += f" after {stats.retries} retr{'y' if stats.retries == 1 else 'ies'}"
                steps.append(
                    TestStep(
                        name="Test completion",
                        ok=True,
                        ms=int((time.perf_counter() - started) * 1000),
                        detail=detail,
                    )
                )
            except GatewayError as error:
                steps.append(
                    TestStep(
                        name="Test completion",
                        ok=False,
                        ms=int((time.perf_counter() - started) * 1000),
                        detail=str(error),
                    )
                )
        elif steps[-1].ok:
            steps.append(
                TestStep(name="Test completion", ok=True, detail="Skipped — no model selected yet")
            )
    except GatewayError as error:
        steps.append(TestStep(name="Configuration", ok=False, detail=str(error)))
    ok = all(s.ok for s in steps)
    cfg.last_test_at = datetime.now(UTC)
    cfg.last_test_ok = ok
    cfg.last_test_message = "; ".join(f"{s.name}: {s.detail}" for s in steps)[:1000]
    await session.commit()
    return TestResult(ok=ok, steps=steps)


# --------------------------------------------------------------- catalogue


class ModelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    owned_by: str | None
    listed: bool
    verified_at: datetime | None
    last_checked_at: datetime | None
    last_error: str | None
    last_latency_ms: int | None


@router.get("/models", response_model=list[ModelOut])
async def list_models(session: Session) -> list[AIModel]:
    rows = await session.scalars(
        select(AIModel).order_by(AIModel.verified_at.is_(None), AIModel.id)
    )
    return list(rows)


@router.post("/models/refresh")
async def refresh_models(session: Session, gw: Gateway) -> dict[str, int]:
    try:
        return {"listed": await gw.refresh_catalog(session)}
    except GatewayError as error:
        raise _error(error) from error


@router.post("/models/{model_id:path}/verify", response_model=ModelOut)
async def verify_model(model_id: str, session: Session, gw: Gateway) -> AIModel:
    try:
        return await gw.verify_model(session, model_id)
    except GatewayError as error:
        raise _error(error) from error


class RouteOut(BaseModel):
    employee_id: str
    model: str | None
    source: str | None


@router.get("/routing", response_model=list[RouteOut])
async def routing(session: Session, gw: Gateway) -> list[RouteOut]:
    """The model each employee would use (no requests are made)."""
    cfg = await gw.config(session)
    departments = {d.key: d for d in await session.scalars(select(Department))}
    out = []
    for e in await session.scalars(select(Employee)):
        d = departments.get(e.department)
        if e.model_id:
            out.append(RouteOut(employee_id=e.id, model=e.model_id, source="employee"))
        elif d and d.model_id:
            out.append(RouteOut(employee_id=e.id, model=d.model_id, source="department"))
        else:
            out.append(
                RouteOut(
                    employee_id=e.id,
                    model=cfg.default_model,
                    source="company default" if cfg.default_model else None,
                )
            )
    return out


# ------------------------------------------------------------------- usage


@router.get("/usage")
async def usage(session: Session, gw: Gateway, hours: int = 24) -> dict[str, Any]:
    cfg = await gw.config(session)
    since = datetime.now(UTC) - timedelta(hours=max(1, min(hours, 24 * 31)))
    window = select(AIUsage).where(AIUsage.created_at >= since)
    rows = list(await session.scalars(window.order_by(AIUsage.id.desc())))

    def total(attr: str) -> int:
        return sum(getattr(r, attr) or 0 for r in rows)

    def group(key: str) -> list[dict[str, Any]]:
        buckets: dict[str, dict[str, Any]] = {}
        for r in rows:
            name = getattr(r, key) or ("direct (no employee)" if key == "department" else "—")
            b = buckets.setdefault(name, {"name": name, "requests": 0, "errors": 0, "tokens": 0})
            if r.status != "rejected":
                b["requests"] += 1
            b["errors"] += r.status == "error"
            b["tokens"] += (r.prompt_tokens or 0) + (r.completion_tokens or 0)
        return sorted(buckets.values(), key=lambda b: -b["requests"])

    day = await session.scalar(
        select(func.count())
        .select_from(AIUsage)
        .where(
            AIUsage.created_at >= datetime.now(UTC) - timedelta(days=1),
            AIUsage.status != "rejected",
        )
    )
    sent = [r for r in rows if r.status != "rejected"]
    latencies = sorted(r.latency_ms for r in rows if r.status == "ok" and r.latency_ms is not None)
    return {
        "window_hours": hours,
        "requests": len(sent),
        "ok": sum(r.status == "ok" for r in rows),
        "errors": sum(r.status == "error" for r in rows),
        "rejected": sum(r.status == "rejected" for r in rows),
        "retries": total("retries"),
        "tokens": {
            "prompt": total("prompt_tokens"),
            "completion": total("completion_tokens"),
            "reasoning": total("reasoning_tokens"),
        },
        "latency_ms": {
            "p50": latencies[len(latencies) // 2] if latencies else None,
            "max": latencies[-1] if latencies else None,
        },
        "budget": {
            "limit": cfg.daily_request_budget,
            "used_24h": day or 0,
            "remaining": max(0, cfg.daily_request_budget - (day or 0)),
        },
        "by_model": group("model"),
        "by_department": group("department"),
        "by_error": [
            {"kind": k, "count": sum(r.error_kind == k for r in rows)}
            for k in sorted({r.error_kind for r in rows if r.error_kind})
        ],
        "recent": [
            {
                "id": r.id,
                "at": r.created_at.isoformat() if r.created_at else None,
                "model": r.model,
                "employee_id": r.employee_id,
                "department": r.department,
                "purpose": r.purpose,
                "status": r.status,
                "error_kind": r.error_kind,
                "http_status": r.http_status,
                "prompt_tokens": r.prompt_tokens,
                "completion_tokens": r.completion_tokens,
                "reasoning_tokens": r.reasoning_tokens,
                "latency_ms": r.latency_ms,
                "first_token_ms": r.first_token_ms,
                "retries": r.retries,
                "streamed": r.streamed,
            }
            for r in rows[:40]
        ],
    }


# -------------------------------------------------------------- playground


class Turn(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(max_length=8000)


class PlaygroundIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    employee_id: str | None = None
    model: str | None = None
    message: str = Field(min_length=1, max_length=8000)
    history: list[Turn] = Field(default_factory=list, max_length=20)


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.post("/playground")
async def playground(body: PlaygroundIn, session: Session, gw: Gateway) -> StreamingResponse:
    """Streams a reply from an employee's routed model (or an explicit model)."""
    messages = [t.model_dump() for t in body.history] + [{"role": "user", "content": body.message}]
    try:
        route, events = await gw.stream(
            session, messages, employee_id=body.employee_id, model=body.model, purpose="playground"
        )
    except GatewayError as error:
        raise _error(error) from error

    async def sse() -> AsyncIterator[str]:
        started = time.perf_counter()
        yield _sse(
            "meta",
            {
                "model": route.model,
                "source": route.source,
                "employee": route.employee.name if route.employee else None,
            },
        )
        reasoning_signalled = False
        try:
            async for event in events:
                if event.kind == "text":
                    yield _sse("token", {"text": event.text})
                elif event.kind == "reasoning" and not reasoning_signalled:
                    reasoning_signalled = True
                    yield _sse("thinking", {})
                elif event.kind == "done" and event.completion:
                    c = event.completion
                    yield _sse(
                        "done",
                        {
                            "finish_reason": c.finish_reason,
                            "prompt_tokens": c.prompt_tokens,
                            "completion_tokens": c.completion_tokens,
                            "reasoning_tokens": c.reasoning_tokens,
                            "first_token_ms": c.first_token_ms,
                            "latency_ms": int((time.perf_counter() - started) * 1000),
                            "empty": not c.content.strip(),
                        },
                    )
        except GatewayError as error:
            yield _sse("error", {"kind": error.kind, "message": str(error)})

    return StreamingResponse(
        sse(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


def ai_status_for_health(
    cfg: AIProviderSettings | None, settings: Settings
) -> tuple[str, str, dict[str, Any]]:
    """Readiness summary without making any provider request."""
    has_key = bool(cfg and cfg.encrypted_api_key) or settings.nvidia_api_key is not None
    data: dict[str, Any] = {
        "provider": "nvidia",
        "key_present": has_key,
        "default_model": cfg.default_model if cfg else None,
    }
    if not has_key:
        return "not_configured", "No NVIDIA API key configured", data
    if cfg and cfg.paused:
        return "paused", "Emergency stop: AI requests are paused", data
    if cfg and cfg.last_test_ok is True:
        return "ok", "Last connection test passed", data
    if cfg and cfg.last_test_ok is False:
        return "error", "Last connection test failed", data
    return "configured", "Key present — run a connection test", data
