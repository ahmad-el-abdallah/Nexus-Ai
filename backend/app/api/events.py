"""Live updates as Server-Sent Events.

One stream per browser tab carries roster/status changes, conversation and
message changes, reply progress and tokens. SSE (rather than WebSockets) passes
through the Next.js /api proxy unchanged, so the browser still talks only to
its own origin; client → server traffic stays on the REST endpoints.
"no-transform" stops the Next.js production server from gzip-buffering the stream.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.core.events import EventBus

router = APIRouter(prefix="/api", tags=["events"])

HEARTBEAT_SECONDS = 15.0


def sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


@router.get("/events")
async def events(request: Request, conversation: str | None = None) -> StreamingResponse:
    bus: EventBus = request.app.state.events

    async def stream() -> AsyncIterator[str]:
        async with bus.subscribe(conversation) as sub:
            yield "retry: 3000\n\n"
            yield sse("ready", {"subscribers": bus.subscriber_count})
            while not bus.closed:
                if sub.overflowed and sub.queue.empty():
                    break
                try:
                    event = await asyncio.wait_for(sub.queue.get(), HEARTBEAT_SECONDS)
                except TimeoutError:
                    # Keeps proxies from timing out an idle connection.
                    yield ": ping\n\n"
                    continue
                if event is None:
                    break
                yield sse(event.type, event.data)
            if sub.overflowed:
                # The client fell too far behind: it should reload its state.
                yield sse("resync", {})

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )
