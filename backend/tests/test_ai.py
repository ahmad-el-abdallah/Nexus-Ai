"""AI gateway, NVIDIA settings and usage — against a scriptable fake provider."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from sqlalchemy import select

from app.main import create_app
from app.models import AIProviderSettings, AIUsage

FAKE_KEY = "nvapi-" + "f" * 40
BASE = "https://integrate.api.nvidia.com/v1"
MASTER = "kQ1q3vU8l2yq4dY7f0s3a9b6c5d4e3f2a1b0c9d8e7f="  # valid Fernet key (44 chars, test only)


class FakeProvider:
    """OpenAI-compatible fake. `script` maps model → list of responses (consumed in order)."""

    def __init__(self) -> None:
        self.calls: list[httpx.Request] = []
        self.models = ["acme/fast-chat", "acme/reasoner", "acme/locked"]
        self.script: dict[str, list[Any]] = {}
        self.inflight = 0
        self.max_inflight = 0
        self.delay = 0.0

    def respond(self, model: str, *responses: Any) -> None:
        self.script.setdefault(model, []).extend(responses)

    async def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if request.headers.get("authorization") != f"Bearer {FAKE_KEY}":
            return httpx.Response(401, json={"title": "Unauthorized"})
        if request.url.path.endswith("/models"):
            return httpx.Response(
                200,
                json={
                    "data": [{"id": m, "object": "model", "owned_by": "acme"} for m in self.models]
                },
            )
        body = json.loads(request.content)
        model = body["model"]
        self.inflight += 1
        self.max_inflight = max(self.max_inflight, self.inflight)
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            planned = self.script.get(model, [])
            action = planned.pop(0) if planned else "ok"
            if isinstance(action, int):
                return httpx.Response(
                    action,
                    json={"detail": f"status {action}"},
                    headers={"retry-after": "0"} if action == 429 else {},
                )
            if action == "timeout":
                raise httpx.ReadTimeout("slow", request=request)
            if model == "acme/locked":
                return httpx.Response(404, json={"detail": "Function not found for account"})
            reasoning = model == "acme/reasoner"
            if body.get("stream"):
                return httpx.Response(
                    200, content=self._sse(reasoning), headers={"content-type": "text/event-stream"}
                )
            return httpx.Response(
                200,
                json={
                    "model": model,
                    "choices": [
                        {
                            "message": {"content": None if reasoning else "ready"},
                            "finish_reason": "length" if reasoning else "stop",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 11,
                        "completion_tokens": 3,
                        "completion_tokens_details": {"reasoning_tokens": 3 if reasoning else 0},
                    },
                },
            )
        finally:
            self.inflight -= 1

    @staticmethod
    def _sse(reasoning: bool) -> bytes:
        chunks = []
        if reasoning:
            chunks.append({"choices": [{"delta": {"reasoning_content": "hmm"}}]})
        else:
            for word in ["Hello", " from", " the", " fake"]:
                chunks.append({"choices": [{"delta": {"content": word}}]})
        chunks.append({"choices": [{"delta": {}, "finish_reason": "stop"}]})
        chunks.append({"choices": [], "usage": {"prompt_tokens": 20, "completion_tokens": 4}})
        return "".join(f"data: {json.dumps(c)}\n\n" for c in chunks).encode() + b"data: [DONE]\n\n"


@pytest.fixture
def fake() -> FakeProvider:
    return FakeProvider()


@pytest.fixture
async def ai_client(
    migrated_db_url, make_settings, fake: FakeProvider
) -> AsyncIterator[httpx.AsyncClient]:
    settings = make_settings(
        NEXUS_DATABASE_URL=migrated_db_url, NVIDIA_API_KEY=FAKE_KEY, NEXUS_SECRET_KEY=MASTER
    )
    app = create_app(settings, ai_transport=httpx.MockTransport(fake.handler))
    async with app.router.lifespan_context(app):
        app.state.ai.sleep = _no_sleep
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as http:
            http.app = app  # type: ignore[attr-defined]
            yield http


async def _no_sleep(_: float) -> None:
    return None


async def ready_catalog(client: httpx.AsyncClient, default: str | None = "acme/fast-chat") -> None:
    assert (await client.post("/api/ai/models/refresh")).status_code == 200
    if default:
        assert (
            await client.patch("/api/ai/settings", json={"default_model": default})
        ).status_code == 200


async def usage_rows(client: httpx.AsyncClient) -> list[AIUsage]:
    async with client.app.state.db.sessionmaker() as session:  # type: ignore[attr-defined]
        return list(await session.scalars(select(AIUsage).order_by(AIUsage.id)))


def sse_events(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        out.append((lines["event"], json.loads(lines["data"])))
    return out


# ------------------------------------------------------------------ settings & key


async def test_settings_never_expose_the_key(ai_client: httpx.AsyncClient) -> None:
    body = (await ai_client.get("/api/ai/settings")).json()
    assert body["key"] == {
        "present": True,
        "source": "env",
        "hint": FAKE_KEY[-4:],
        "updated_at": None,
        "can_save": True,
    }
    assert FAKE_KEY not in json.dumps(body)
    assert body["base_url"] == BASE


async def test_saved_key_is_encrypted_at_rest_and_preferred(ai_client: httpx.AsyncClient) -> None:
    other = "nvapi-" + "s" * 40
    response = await ai_client.put("/api/ai/key", json={"api_key": other})
    assert response.status_code == 200
    assert response.json()["key"]["source"] == "app"
    assert other not in response.text
    async with ai_client.app.state.db.sessionmaker() as session:  # type: ignore[attr-defined]
        cfg = await session.get(AIProviderSettings, "nvidia")
        assert cfg.encrypted_api_key and other not in cfg.encrypted_api_key
    # The saved key is now used — and it's wrong for the fake, so auth fails clearly.
    result = (await ai_client.post("/api/ai/test", json={})).json()
    assert result["ok"] is False
    assert "rejected the API key" in result["steps"][0]["detail"]
    # Removing it falls back to the key in backend/.env.
    assert (await ai_client.delete("/api/ai/key")).json()["key"]["source"] == "env"
    assert (await ai_client.post("/api/ai/test", json={})).json()["ok"] is True


async def test_keys_need_the_secret_store(
    migrated_db_url, make_settings, fake: FakeProvider
) -> None:
    app = create_app(
        make_settings(NEXUS_DATABASE_URL=migrated_db_url, NVIDIA_API_KEY=FAKE_KEY),
        ai_transport=httpx.MockTransport(fake.handler),
    )
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as http,
    ):
        response = await http.put("/api/ai/key", json={"api_key": "nvapi-" + "x" * 40})
        assert response.status_code == 409
        assert "NEXUS_SECRET_KEY" in response.json()["detail"]


async def test_settings_validation(ai_client: httpx.AsyncClient) -> None:
    assert (
        await ai_client.patch("/api/ai/settings", json={"base_url": "http://evil.example.com/v1"})
    ).status_code == 422
    assert (
        await ai_client.patch("/api/ai/settings", json={"base_url": "http://127.0.0.1:9999/v1"})
    ).status_code == 200
    assert (
        await ai_client.patch("/api/ai/settings", json={"default_model": "not/listed"})
    ).status_code == 422
    assert (await ai_client.patch("/api/ai/settings", json={"temperature": 5})).status_code == 422
    assert (await ai_client.put("/api/ai/key", json={"api_key": "short"})).status_code == 422


# ------------------------------------------------------------------ catalogue


async def test_catalog_lists_models_and_verification_finds_unusable_ones(
    ai_client: httpx.AsyncClient,
) -> None:
    await ready_catalog(ai_client, default=None)
    models = {m["id"]: m for m in (await ai_client.get("/api/ai/models")).json()}
    assert set(models) == {"acme/fast-chat", "acme/reasoner", "acme/locked"}
    ok = (await ai_client.post("/api/ai/models/acme/fast-chat/verify")).json()
    assert ok["verified_at"] is not None and ok["last_error"] is None
    locked = (await ai_client.post("/api/ai/models/acme/locked/verify")).json()
    assert locked["verified_at"] is None
    assert "isn't available to your NVIDIA account" in locked["last_error"]


async def test_connection_test_reports_each_step(ai_client: httpx.AsyncClient) -> None:
    await ready_catalog(ai_client)
    result = (await ai_client.post("/api/ai/test", json={})).json()
    assert result["ok"] is True
    assert [s["name"] for s in result["steps"]] == ["Authenticate & list models", "Test completion"]
    assert "3 models listed" in result["steps"][0]["detail"]
    assert "ready" in result["steps"][1]["detail"]
    health = (await ai_client.get("/api/health/ready")).json()["components"]["ai_provider"]
    assert health["status"] == "ok"


async def test_reasoning_only_reply_is_explained(ai_client: httpx.AsyncClient) -> None:
    await ready_catalog(ai_client, default="acme/reasoner")
    detail = (await ai_client.post("/api/ai/test", json={})).json()["steps"][1]["detail"]
    assert "no visible text" in detail


# ------------------------------------------------------------- resilience & limits


async def test_rate_limits_are_retried_then_succeed(
    ai_client: httpx.AsyncClient, fake: FakeProvider
) -> None:
    await ready_catalog(ai_client)
    fake.respond("acme/fast-chat", 429, 503)
    result = (await ai_client.post("/api/ai/test", json={})).json()
    assert result["ok"] is True
    assert "after 2 retries" in result["steps"][1]["detail"]
    row = (await usage_rows(ai_client))[-1]
    assert (row.status, row.retries, row.purpose) == ("ok", 2, "connection_test")


async def test_persistent_rate_limit_fails_clearly_without_fallback(
    ai_client: httpx.AsyncClient, fake: FakeProvider
) -> None:
    await ready_catalog(ai_client)
    fake.respond("acme/fast-chat", 429, 429, 429)
    result = (await ai_client.post("/api/ai/test", json={})).json()
    assert result["ok"] is False
    assert "rate limit" in result["steps"][1]["detail"]
    # Every request went to the configured provider: no other host was contacted.
    assert {c.url.host for c in fake.calls} == {"integrate.api.nvidia.com"}
    row = (await usage_rows(ai_client))[-1]
    assert (row.status, row.error_kind, row.retries) == ("error", "rate_limited", 2)


async def test_timeouts_are_reported(ai_client: httpx.AsyncClient, fake: FakeProvider) -> None:
    await ready_catalog(ai_client)
    fake.respond("acme/fast-chat", "timeout")
    result = (await ai_client.post("/api/ai/test", json={})).json()
    assert "timeout" in result["steps"][1]["detail"]
    assert (await usage_rows(ai_client))[-1].error_kind == "timeout"


async def test_daily_budget_blocks_requests_before_sending(
    ai_client: httpx.AsyncClient, fake: FakeProvider
) -> None:
    await ready_catalog(ai_client)
    await ai_client.patch("/api/ai/settings", json={"daily_request_budget": 1})
    assert (await ai_client.post("/api/ai/test", json={})).json()["ok"] is True
    sent_before = len(fake.calls)
    response = await ai_client.post("/api/ai/playground", json={"message": "hi"})
    assert response.status_code == 429
    assert response.json()["detail"]["kind"] == "budget"
    assert len(fake.calls) == sent_before  # nothing left the app
    assert (await usage_rows(ai_client))[-1].status == "rejected"


async def test_department_budget_applies_to_its_employees(ai_client: httpx.AsyncClient) -> None:
    await ready_catalog(ai_client)
    staff = (await ai_client.get("/api/employees")).json()
    priya = next(e for e in staff if e["name"] == "Priya Nair")
    await ai_client.patch("/api/departments/sales", json={"daily_request_budget": 0})
    response = await ai_client.post(
        "/api/ai/playground", json={"message": "hi", "employee_id": priya["id"]}
    )
    assert response.status_code == 429
    assert "Sales" in response.json()["detail"]["message"]


async def test_emergency_stop_blocks_everything(
    ai_client: httpx.AsyncClient, fake: FakeProvider
) -> None:
    await ready_catalog(ai_client)
    await ai_client.patch("/api/ai/settings", json={"paused": True})
    calls = len(fake.calls)
    assert (await ai_client.post("/api/ai/playground", json={"message": "hi"})).status_code == 423
    assert (await ai_client.post("/api/ai/models/refresh")).status_code == 423
    assert (await ai_client.post("/api/ai/test", json={})).json()["ok"] is False
    assert len(fake.calls) == calls
    assert (await ai_client.get("/api/health/ready")).json()["components"]["ai_provider"][
        "status"
    ] == "paused"


async def test_concurrency_limit_is_enforced(
    ai_client: httpx.AsyncClient, fake: FakeProvider
) -> None:
    await ready_catalog(ai_client)
    await ai_client.patch("/api/ai/settings", json={"concurrency_limit": 1})
    fake.delay = 0.05
    gw = ai_client.app.state.ai  # type: ignore[attr-defined]

    async def one() -> None:
        async with gw.database.sessionmaker() as session:
            await gw.complete(session, [{"role": "user", "content": "x"}], purpose="test")

    await asyncio.gather(*(one() for _ in range(4)))
    assert fake.max_inflight == 1


# --------------------------------------------------------------------- routing


async def test_model_routing_employee_then_department_then_default(
    ai_client: httpx.AsyncClient,
) -> None:
    await ready_catalog(ai_client)
    staff = {e["name"]: e for e in (await ai_client.get("/api/employees")).json()}
    priya, marcus = staff["Priya Nair"], staff["Marcus Bell"]
    assert (
        await ai_client.patch("/api/departments/sales", json={"model_id": "acme/reasoner"})
    ).status_code == 200
    assert (
        await ai_client.patch(f"/api/employees/{priya['id']}", json={"model_id": "acme/fast-chat"})
    ).status_code == 200
    routes = {r["employee_id"]: r for r in (await ai_client.get("/api/ai/routing")).json()}
    assert routes[priya["id"]] == {
        "employee_id": priya["id"],
        "model": "acme/fast-chat",
        "source": "employee",
    }
    assert routes[marcus["id"]]["source"] == "department"
    assert routes[staff["Iris Wong"]["id"]] == {
        "employee_id": staff["Iris Wong"]["id"],
        "model": "acme/fast-chat",
        "source": "company default",
    }
    # Unknown models can't be assigned.
    assert (
        await ai_client.patch(f"/api/employees/{priya['id']}", json={"model_id": "made/up"})
    ).status_code == 422
    assert (
        await ai_client.patch("/api/departments/sales", json={"model_id": "made/up"})
    ).status_code == 422


async def test_no_model_selected_is_a_clear_error(ai_client: httpx.AsyncClient) -> None:
    await ready_catalog(ai_client, default=None)
    response = await ai_client.post("/api/ai/playground", json={"message": "hi"})
    assert response.status_code == 409
    assert response.json()["detail"]["kind"] == "no_model"


# ------------------------------------------------------------------- streaming


async def test_playground_streams_as_the_employee(
    ai_client: httpx.AsyncClient, fake: FakeProvider
) -> None:
    await ready_catalog(ai_client)
    iris = next(
        e for e in (await ai_client.get("/api/employees")).json() if e["name"] == "Iris Wong"
    )
    response = await ai_client.post(
        "/api/ai/playground", json={"message": "secret-plan-xyz", "employee_id": iris["id"]}
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = sse_events(response.text)
    assert events[0] == (
        "meta",
        {"model": "acme/fast-chat", "source": "company default", "employee": "Iris Wong"},
    )
    assert "".join(d["text"] for e, d in events if e == "token") == "Hello from the fake"
    done = events[-1][1]
    assert events[-1][0] == "done" and done["completion_tokens"] == 4 and done["empty"] is False
    # The employee's identity was sent as the system prompt.
    sent = json.loads(fake.calls[-1].content)
    assert sent["stream"] is True
    assert "You are Iris Wong, Chief Technology Officer" in sent["messages"][0]["content"]
    # Usage is recorded without any of the conversation text.
    rows = await usage_rows(ai_client)
    assert (
        rows[-1].streamed
        and rows[-1].employee_id == iris["id"]
        and rows[-1].department == "engineering"
    )
    usage = (await ai_client.get("/api/ai/usage")).text
    assert "secret-plan-xyz" not in usage and "Hello from the fake" not in usage


async def test_reasoning_stream_signals_thinking_and_empty_reply(
    ai_client: httpx.AsyncClient,
) -> None:
    await ready_catalog(ai_client, default="acme/reasoner")
    events = sse_events((await ai_client.post("/api/ai/playground", json={"message": "hi"})).text)
    kinds = [e for e, _ in events]
    assert kinds == ["meta", "thinking", "done"]
    assert events[-1][1]["empty"] is True


async def test_stream_errors_arrive_as_events(ai_client: httpx.AsyncClient) -> None:
    await ready_catalog(ai_client)
    events = sse_events(
        (
            await ai_client.post(
                "/api/ai/playground", json={"message": "hi", "model": "acme/locked"}
            )
        ).text
    )
    assert events[-1][0] == "error"
    assert events[-1][1]["kind"] == "model_unavailable"


async def test_usage_summary(ai_client: httpx.AsyncClient, fake: FakeProvider) -> None:
    await ready_catalog(ai_client)
    await ai_client.post("/api/ai/test", json={})
    fake.respond("acme/fast-chat", 401)
    await ai_client.post("/api/ai/playground", json={"message": "hi"})
    usage = (await ai_client.get("/api/ai/usage")).json()
    assert usage["requests"] == 2 and usage["ok"] == 1 and usage["errors"] == 1
    assert usage["tokens"]["prompt"] == 11
    assert usage["budget"]["used_24h"] == 2
    assert {m["name"] for m in usage["by_model"]} == {"acme/fast-chat"}
    assert usage["by_error"] == [{"kind": "auth", "count": 1}]


def test_usage_table_has_no_content_columns() -> None:
    columns = set(AIUsage.__table__.columns.keys())
    assert not columns & {"prompt", "content", "messages", "reply", "text"}


async def test_concurrent_first_requests_share_one_settings_row(
    ai_client: httpx.AsyncClient,
) -> None:
    responses = await asyncio.gather(
        *(ai_client.get("/api/ai/settings") for _ in range(6)), ai_client.get("/api/ai/usage")
    )
    assert all(r.status_code == 200 for r in responses)
