"""The AI gateway: the only path from NEXUS AI to a model provider.

Every request passes through, in order:
  1. the emergency stop,
  2. the global and per-department daily request budgets,
  3. the global and per-department concurrency limits,
  4. the provider call with a timeout and bounded retries (429 / 5xx / network),
and leaves one usage record (never the prompt or reply). There is no fallback
to any other (paid) provider: failures are reported, not hidden.
"""

from __future__ import annotations

import asyncio
import random
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.provider import Completion, OpenAICompatibleProvider, ProviderError, StreamEvent
from app.ai.secrets import SecretStoreError, decrypt
from app.core.config import Settings
from app.core.logging import get_logger
from app.db.session import Database
from app.models import AIModel, AIProviderSettings, AIUsage, Department, Employee
from app.services.company import company_briefing

log = get_logger("nexus.ai")

PROVIDER = "nvidia"
MAX_RETRIES = 2
MAX_RETRY_AFTER = 10.0


class GatewayError(Exception):
    """A request that was refused locally or failed at the provider."""

    def __init__(self, kind: str, message: str, http_status: int = 502) -> None:
        super().__init__(message)
        self.kind = kind
        self.http_status = http_status


class DynamicLimiter:
    """A semaphore whose size can change at runtime."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.active = 0
        self._cond = asyncio.Condition()

    @asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        async with self._cond:
            await self._cond.wait_for(lambda: self.active < self.limit)
            self.active += 1
        try:
            yield
        finally:
            async with self._cond:
                self.active -= 1
                self._cond.notify_all()


@dataclass
class Route:
    model: str
    source: str  # "employee" | "department" | "company default" | "explicit"
    employee: Employee | None
    department: Department | None


@dataclass
class CallStats:
    retries: int = 0
    http_status: int | None = None


def system_prompt(
    employee: Employee, department: Department | None, context: str | None = None
) -> str:
    lines = [
        f"You are {employee.name}, {employee.role} in the {department.name if department else employee.department} department of NEXUS AI,",
        "a company whose employees are AI agents working for its human owner.",
    ]
    if department:
        lines.append(f"Department mission: {department.description}")
        lines.append("Responsibilities: " + "; ".join(department.responsibilities) + ".")
    lines += [
        "Rules: be concise and professional. You can only reply in this conversation — you cannot send email, browse,",
        "spend money or act outside it. Never invent facts, data or sources; say clearly when you don't know or when",
        "something is your assumption. Sensitive or external actions always need the owner's approval.",
        "Language: write only in English or Arabic — Arabic when the owner writes to you in Arabic,",
        "otherwise English. Never use any other language, and never translate the owner's words back to them.",
    ]
    if employee.gender == "female":
        lines.append(
            "You are a woman. In Arabic, always use feminine forms when you speak about yourself "
            "(for example: أنا سعيدة، أنا جاهزة، كنتُ مشغولة)."
        )
    elif employee.gender == "male":
        lines.append(
            "You are a man. In Arabic, always use masculine forms when you speak about yourself "
            "(for example: أنا سعيد، أنا جاهز، كنتُ مشغولاً)."
        )
    if context:
        lines.append(context)
    return "\n".join(lines)


class AIGateway:
    def __init__(
        self,
        database: Database,
        settings: Settings,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.database = database
        self.settings = settings
        self.transport = transport
        self.sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
        self._global = DynamicLimiter(2)
        self._departments: dict[str, DynamicLimiter] = {}

    # ------------------------------------------------------------------ config

    async def config(self, session: AsyncSession) -> AIProviderSettings:
        cfg = await session.get(AIProviderSettings, PROVIDER)
        if cfg is None:
            cfg = AIProviderSettings(
                provider=PROVIDER,
                base_url=self.settings.nvidia_base_url,
                max_output_tokens=1024,
                temperature=0.4,
                timeout_seconds=60,
                concurrency_limit=2,
                daily_request_budget=500,
                paused=False,
            )
            session.add(cfg)
            try:
                await session.commit()
            except IntegrityError:
                # Another request created the row at the same time: use theirs.
                await session.rollback()
                cfg = await session.get(AIProviderSettings, PROVIDER, populate_existing=True)
                assert cfg is not None
                return cfg
            await session.refresh(cfg)
        return cfg

    def api_key(self, cfg: AIProviderSettings) -> tuple[str | None, str | None]:
        """(key, source): a key saved in the app wins over NVIDIA_API_KEY in backend/.env."""
        if cfg.encrypted_api_key:
            return decrypt(self.settings, cfg.encrypted_api_key), "app"
        if self.settings.nvidia_api_key is not None:
            return self.settings.nvidia_api_key.get_secret_value(), "env"
        return None, None

    def _provider(self, cfg: AIProviderSettings) -> OpenAICompatibleProvider:
        try:
            key, _ = self.api_key(cfg)
        except SecretStoreError as error:
            raise GatewayError("key_unreadable", str(error), 500) from error
        if not key:
            raise GatewayError(
                "not_configured",
                "No NVIDIA API key is configured. Add one in Settings → AI providers.",
                409,
            )
        return OpenAICompatibleProvider(
            cfg.base_url, key, cfg.timeout_seconds, transport=self.transport
        )

    # ----------------------------------------------------------------- routing

    async def resolve(
        self,
        session: AsyncSession,
        cfg: AIProviderSettings,
        employee_id: str | None,
        model: str | None = None,
    ) -> Route:
        employee = await session.get(Employee, employee_id) if employee_id else None
        if employee_id and employee is None:
            raise GatewayError("unknown_employee", "Unknown employee", 404)
        department = await session.get(Department, employee.department) if employee else None
        if model:
            return Route(model, "explicit", employee, department)
        if employee and employee.model_id:
            return Route(employee.model_id, "employee", employee, department)
        if department and department.model_id:
            return Route(department.model_id, "department", employee, department)
        if cfg.default_model:
            return Route(cfg.default_model, "company default", employee, department)
        raise GatewayError(
            "no_model",
            "No model is selected. Choose a company default model in Settings → AI providers.",
            409,
        )

    # ------------------------------------------------------------------- guard

    async def _guard(
        self, session: AsyncSession, cfg: AIProviderSettings, department: Department | None
    ) -> None:
        if cfg.paused:
            raise GatewayError("paused", "AI requests are paused by the emergency stop.", 423)
        since = datetime.now(UTC) - timedelta(days=1)
        sent = (
            select(func.count())
            .select_from(AIUsage)
            .where(AIUsage.created_at >= since, AIUsage.status != "rejected")
        )
        if (await session.scalar(sent) or 0) >= cfg.daily_request_budget:
            raise GatewayError(
                "budget",
                f"The company's daily AI request budget ({cfg.daily_request_budget}) is used up.",
                429,
            )
        if department is not None:
            dept_sent = await session.scalar(sent.where(AIUsage.department == department.key)) or 0
            if dept_sent >= department.daily_request_budget:
                raise GatewayError(
                    "budget",
                    f"{department.name}'s daily AI request budget ({department.daily_request_budget}) is used up.",
                    429,
                )

    @asynccontextmanager
    async def _slots(
        self, cfg: AIProviderSettings, department: Department | None
    ) -> AsyncIterator[None]:
        self._global.limit = cfg.concurrency_limit
        if department is None:
            async with self._global.slot():
                yield
            return
        limiter = self._departments.setdefault(
            department.key, DynamicLimiter(department.max_concurrent_tasks)
        )
        limiter.limit = department.max_concurrent_tasks
        async with limiter.slot(), self._global.slot():
            yield

    async def _record(self, **fields: object) -> None:
        async with self.database.sessionmaker() as session:
            session.add(AIUsage(provider=PROVIDER, **fields))
            await session.commit()

    async def _backoff(self, attempt: int, error: ProviderError) -> None:
        delay = min(error.retry_after, MAX_RETRY_AFTER) if error.retry_after else 2**attempt * 0.75
        await self.sleep(delay + random.uniform(0, 0.25))  # noqa: S311 - jitter, not security

    async def _context_with_company(
        self, session: AsyncSession, employee: Employee, context: str | None
    ) -> str:
        """Every employee answers with the live company data their position gives access to."""
        briefing = await company_briefing(session, employee)
        return "\n\n".join(part for part in (context, briefing) if part)

    # --------------------------------------------------------------- requests

    async def complete(
        self,
        session: AsyncSession,
        messages: list[dict[str, str]],
        *,
        employee_id: str | None = None,
        model: str | None = None,
        purpose: str,
        max_tokens: int | None = None,
        context: str | None = None,
    ) -> tuple[Completion, Route, CallStats]:
        """One non-streamed call. `context` extends the employee's system prompt."""
        cfg = await self.config(session)
        route = await self.resolve(session, cfg, employee_id, model)
        base = {
            "model": route.model,
            "employee_id": route.employee.id if route.employee else None,
            "department": route.department.key if route.department else None,
            "purpose": purpose,
        }
        try:
            await self._guard(session, cfg, route.department)
            provider = self._provider(cfg)
        except GatewayError as error:
            await self._record(
                **base, status="rejected", error_kind=error.kind, retries=0, streamed=False
            )
            raise
        if route.employee:
            messages = [
                {
                    "role": "system",
                    "content": system_prompt(
                        route.employee,
                        route.department,
                        await self._context_with_company(session, route.employee, context),
                    ),
                },
                *messages,
            ]
        stats = CallStats()
        started = time.perf_counter()
        async with self._slots(cfg, route.department):
            for attempt in range(MAX_RETRIES + 1):
                try:
                    completion = await provider.complete(
                        route.model, messages, max_tokens or cfg.max_output_tokens, cfg.temperature
                    )
                    break
                except ProviderError as error:
                    stats.http_status = error.status
                    if error.retryable and attempt < MAX_RETRIES:
                        stats.retries += 1
                        await self._backoff(attempt, error)
                        continue
                    await self._record(
                        **base,
                        status="error",
                        error_kind=error.kind,
                        http_status=error.status,
                        latency_ms=int((time.perf_counter() - started) * 1000),
                        retries=stats.retries,
                        streamed=False,
                    )
                    log.warning(
                        "ai.request_failed",
                        model=route.model,
                        kind=error.kind,
                        status=error.status,
                        retries=stats.retries,
                    )
                    raise GatewayError(
                        error.kind, str(error), 502 if error.kind != "rate_limited" else 429
                    ) from error
        await self._record(
            **base,
            status="ok",
            http_status=200,
            prompt_tokens=completion.prompt_tokens,
            completion_tokens=completion.completion_tokens,
            reasoning_tokens=completion.reasoning_tokens,
            latency_ms=int((time.perf_counter() - started) * 1000),
            first_token_ms=completion.first_token_ms,
            retries=stats.retries,
            streamed=False,
        )
        return completion, route, stats

    async def stream(
        self,
        session: AsyncSession,
        messages: list[dict[str, str]],
        *,
        employee_id: str | None = None,
        model: str | None = None,
        purpose: str,
        context: str | None = None,
        max_tokens: int | None = None,
    ) -> tuple[Route, AsyncIterator[StreamEvent]]:
        """Validates and routes first (errors raise before streaming starts),
        then returns the route and an iterator of stream events. The first event
        is "started" once the request holds its concurrency slots (until then it
        is queued behind other requests). `context` extends the employee's
        system prompt."""
        cfg = await self.config(session)
        route = await self.resolve(session, cfg, employee_id, model)
        base = {
            "model": route.model,
            "employee_id": route.employee.id if route.employee else None,
            "department": route.department.key if route.department else None,
            "purpose": purpose,
        }
        try:
            await self._guard(session, cfg, route.department)
            provider = self._provider(cfg)
        except GatewayError as error:
            await self._record(
                **base, status="rejected", error_kind=error.kind, retries=0, streamed=True
            )
            raise
        if route.employee:
            messages = [
                {
                    "role": "system",
                    "content": system_prompt(
                        route.employee,
                        route.department,
                        await self._context_with_company(session, route.employee, context),
                    ),
                },
                *messages,
            ]
        max_tokens, temperature = max_tokens or cfg.max_output_tokens, cfg.temperature

        async def events() -> AsyncIterator[StreamEvent]:
            stats = CallStats()
            started = time.perf_counter()
            async with self._slots(cfg, route.department):
                yield StreamEvent("started")
                for attempt in range(MAX_RETRIES + 1):
                    produced = False
                    try:
                        async for event in provider.stream(
                            route.model, messages, max_tokens, temperature
                        ):
                            if event.kind != "done":
                                produced = True
                                yield event
                                continue
                            c = event.completion
                            assert c is not None
                            await self._record(
                                **base,
                                status="ok",
                                http_status=200,
                                prompt_tokens=c.prompt_tokens,
                                completion_tokens=c.completion_tokens,
                                reasoning_tokens=c.reasoning_tokens,
                                latency_ms=int((time.perf_counter() - started) * 1000),
                                first_token_ms=c.first_token_ms,
                                retries=stats.retries,
                                streamed=True,
                            )
                            yield event
                        return
                    except (asyncio.CancelledError, GeneratorExit):
                        # The client went away mid-stream: tokens may have been spent, so record it.
                        await asyncio.shield(
                            self._record(
                                **base,
                                status="error",
                                error_kind="cancelled",
                                latency_ms=int((time.perf_counter() - started) * 1000),
                                retries=stats.retries,
                                streamed=True,
                            )
                        )
                        raise
                    except ProviderError as error:
                        # Retry only if nothing was streamed yet (never duplicate output).
                        if error.retryable and not produced and attempt < MAX_RETRIES:
                            stats.retries += 1
                            await self._backoff(attempt, error)
                            continue
                        await self._record(
                            **base,
                            status="error",
                            error_kind=error.kind,
                            http_status=error.status,
                            latency_ms=int((time.perf_counter() - started) * 1000),
                            retries=stats.retries,
                            streamed=True,
                        )
                        log.warning(
                            "ai.stream_failed",
                            model=route.model,
                            kind=error.kind,
                            status=error.status,
                        )
                        raise GatewayError(error.kind, str(error)) from error

        return route, events()

    # ----------------------------------------------------------- catalogue

    async def refresh_catalog(self, session: AsyncSession) -> int:
        cfg = await self.config(session)
        if cfg.paused:
            raise GatewayError("paused", "AI requests are paused by the emergency stop.", 423)
        provider = self._provider(cfg)
        try:
            listed = await provider.list_models()
        except ProviderError as error:
            raise GatewayError(error.kind, str(error)) from error
        ids = {m["id"]: m for m in listed if isinstance(m.get("id"), str)}
        existing = {m.id: m for m in await session.scalars(select(AIModel))}
        for model_id, meta in ids.items():
            row = existing.get(model_id)
            if row is None:
                session.add(
                    AIModel(
                        id=model_id, provider=PROVIDER, owned_by=meta.get("owned_by"), listed=True
                    )
                )
            else:
                row.listed = True
        for model_id, row in existing.items():
            if model_id not in ids:
                row.listed = False
        await session.commit()
        log.info("ai.catalog_refreshed", models=len(ids))
        return len(ids)

    async def verify_model(self, session: AsyncSession, model_id: str) -> AIModel:
        row = await session.get(AIModel, model_id)
        if row is None:
            raise GatewayError(
                "unknown_model",
                "That model isn't in the catalogue; refresh the model list first.",
                404,
            )
        now = datetime.now(UTC)
        try:
            completion, _, _ = await self.complete(
                session,
                [{"role": "user", "content": "Reply with the single word: ready"}],
                model=model_id,
                purpose="verify",
                max_tokens=64,
            )
            row.verified_at = now
            row.last_error = None
            row.last_latency_ms = completion.first_token_ms
        except GatewayError as error:
            if error.kind in ("paused", "budget", "not_configured", "key_unreadable"):
                raise
            row.last_error = str(error)
            if error.kind in ("model_unavailable", "bad_request"):
                row.verified_at = None
        row.last_checked_at = now
        await session.commit()
        await session.refresh(row)
        return row
