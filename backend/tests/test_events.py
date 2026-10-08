"""The in-process event bus behind /api/events."""

from __future__ import annotations

from app.core import events as events_module
from app.core.events import EventBus


async def test_conversation_filter_and_broadcast() -> None:
    bus = EventBus()
    async with bus.subscribe() as everything, bus.subscribe("cnv_a") as only_a:
        bus.publish("employee.updated", {"id": "e1"})
        bus.publish("message.token", {"text": "a"}, conversation_id="cnv_a")
        bus.publish("message.token", {"text": "b"}, conversation_id="cnv_b")
        assert everything.queue.qsize() == 3
        got = [only_a.queue.get_nowait() for _ in range(only_a.queue.qsize())]
        assert [(e.type, e.data) for e in got if e] == [
            ("employee.updated", {"id": "e1"}),
            ("message.token", {"text": "a"}),
        ]
    assert bus.subscriber_count == 0


async def test_slow_subscribers_are_dropped(monkeypatch) -> None:
    monkeypatch.setattr(events_module, "QUEUE_LIMIT", 2)
    bus = EventBus()
    async with bus.subscribe() as sub:
        for i in range(3):
            bus.publish("x", {"i": i})
        assert sub.overflowed
        assert bus.subscriber_count == 0


async def test_close_ends_every_stream() -> None:
    bus = EventBus()
    async with bus.subscribe() as sub:
        bus.close()
        assert bus.closed
        assert sub.queue.get_nowait() is None
