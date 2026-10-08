"""In-process publish/subscribe for live updates (served to browsers as Server-Sent Events).

Events are notifications, not the source of truth: every event describes a change
that is already committed to the database, so a client that misses events can
always recover by reloading. Slow subscribers are disconnected rather than
allowed to grow memory without bound.
"""

from __future__ import annotations

import asyncio
import weakref
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

QUEUE_LIMIT = 1000


@dataclass
class Event:
    type: str
    data: dict[str, Any]
    # Token events carry their conversation; subscribers may watch just one.
    conversation_id: str | None = None


@dataclass(eq=False)
class Subscription:
    conversation_id: str | None = None  # None: everything
    queue: asyncio.Queue[Event | None] = field(default_factory=lambda: asyncio.Queue(QUEUE_LIMIT))
    overflowed: bool = False


_buses: weakref.WeakSet[EventBus] = weakref.WeakSet()


class EventBus:
    def __init__(self) -> None:
        self._subscribers: set[Subscription] = set()
        self.closed = False
        try:
            self._loop: asyncio.AbstractEventLoop | None = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = None
        _buses.add(self)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    def publish(
        self, type: str, data: dict[str, Any], *, conversation_id: str | None = None
    ) -> None:
        """Broadcast an event. Events tagged with a conversation skip subscribers
        that watch a different conversation."""
        event = Event(type, data, conversation_id)
        for sub in list(self._subscribers):
            if conversation_id and sub.conversation_id not in (None, conversation_id):
                continue
            try:
                sub.queue.put_nowait(event)
            except asyncio.QueueFull:
                sub.overflowed = True
                self._subscribers.discard(sub)

    @asynccontextmanager
    async def subscribe(self, conversation_id: str | None = None) -> AsyncIterator[Subscription]:
        sub = Subscription(conversation_id)
        self._subscribers.add(sub)
        try:
            yield sub
        finally:
            self._subscribers.discard(sub)

    def close(self) -> None:
        """Ends every open stream (used on shutdown so servers can stop promptly)."""
        self.closed = True
        for sub in list(self._subscribers):
            try:
                sub.queue.put_nowait(None)
            except asyncio.QueueFull:
                sub.overflowed = True
        self._subscribers.clear()


def _close_all_from_signal() -> None:
    for bus in list(_buses):
        if bus._loop is not None and not bus._loop.is_closed():
            bus._loop.call_soon_threadsafe(bus.close)


def install_shutdown_hook() -> None:
    """Uvicorn waits for open responses before shutting down, and event streams
    never end on their own. End them as soon as the server is asked to exit."""
    try:
        from uvicorn.server import Server
    except ImportError:  # pragma: no cover - another server
        return
    original = Server.handle_exit
    if getattr(original, "_nexus_hook", False):
        return

    def handle_exit(self: Server, sig: int, frame: object) -> None:
        _close_all_from_signal()
        original(self, sig, frame)  # type: ignore[arg-type]

    handle_exit._nexus_hook = True  # type: ignore[attr-defined]
    Server.handle_exit = handle_exit  # type: ignore[method-assign]
