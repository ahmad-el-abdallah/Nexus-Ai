"""A tiny OpenAI-compatible provider for end-to-end tests (no real model, no network).

Run: uv run uvicorn tests.fake_provider:app --port 18300
Models: fake/fast (works, streams), fake/locked (404 for this account).
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import StreamingResponse

from tests.fake_agents import canned_reply

FAKE_KEY = "fake-e2e-key-0123456789abcdef"
REPLY = "Hello from the NEXUS test provider."

app = FastAPI()


def _auth(authorization: str | None) -> None:
    if authorization != f"Bearer {FAKE_KEY}":
        raise HTTPException(401, {"title": "Unauthorized"})


@app.get("/v1/models")
async def models(authorization: str | None = Header(default=None)) -> dict:
    _auth(authorization)
    return {
        "data": [
            {"id": m, "object": "model", "owned_by": "fake"}
            for m in ("fake/fast", "fake/locked", "fake/other")
        ]
    }


@app.post("/v1/chat/completions", response_model=None)
async def chat(
    request: Request, authorization: str | None = Header(default=None)
) -> dict | StreamingResponse:
    _auth(authorization)
    body = await request.json()
    if body["model"] == "fake/locked":
        raise HTTPException(404, {"detail": "Function not found for account"})
    # Workflow steps (plan, breakdown, work, review, summary, report) get valid replies.
    canned = canned_reply(body["messages"][-1]["content"])
    if canned is not None and body.get("stream"):

        async def typed() -> AsyncIterator[str]:
            words = canned.split(" ")
            for i in range(0, len(words), 4):  # a few words at a time, like a real model
                await asyncio.sleep(0.08)
                piece = " ".join(words[i : i + 4]) + (" " if i + 4 < len(words) else "")
                yield f"data: {json.dumps({'choices': [{'delta': {'content': piece}}]})}\n\n"
            yield f"data: {json.dumps({'choices': [{'delta': {}, 'finish_reason': 'stop'}]})}\n\n"
            yield f"data: {json.dumps({'choices': [], 'usage': {'prompt_tokens': 120, 'completion_tokens': 60}})}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(typed(), media_type="text/event-stream")
    if not body.get("stream"):
        if canned is not None:
            await asyncio.sleep(0.4)  # long enough for the UI to show each step
            return {
                "model": body["model"],
                "choices": [{"message": {"content": canned}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 120, "completion_tokens": 60},
            }
        return {
            "model": body["model"],
            "choices": [{"message": {"content": "ready"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 1},
        }

    async def events() -> AsyncIterator[str]:
        for word in REPLY.split(" "):
            await asyncio.sleep(0.05)
            yield f"data: {json.dumps({'choices': [{'delta': {'content': word + ' '}}]})}\n\n"
        yield f"data: {json.dumps({'choices': [{'delta': {}, 'finish_reason': 'stop'}]})}\n\n"
        yield f"data: {json.dumps({'choices': [], 'usage': {'prompt_tokens': 30, 'completion_tokens': 7}})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(events(), media_type="text/event-stream")
