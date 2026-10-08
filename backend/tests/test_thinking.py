"""Fast replies: chat and voice answer directly unless the owner turns thinking on."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from app.ai.provider import OpenAICompatibleProvider, can_switch_thinking
from tests import test_chat
from tests.test_chat import app_of, open_chat

fake = test_chat.fake
chat_client = test_chat.chat_client


def test_only_models_that_support_it_are_told_not_to_think() -> None:
    provider = OpenAICompatibleProvider.__new__(OpenAICompatibleProvider)
    nemotron = "nvidia/nemotron-3-super-120b-a12b"
    off = provider._body(nemotron, [], 100, 0.4, True, thinking=False)
    assert off["chat_template_kwargs"] == {"enable_thinking": False}
    assert "chat_template_kwargs" not in provider._body(nemotron, [], 100, 0.4, True)
    other = provider._body("openai/gpt-oss-20b", [], 100, 0.4, True, thinking=False)
    assert "chat_template_kwargs" not in other
    assert can_switch_thinking("nvidia/nemotron-3.5-lightning-30b-a3b")


async def test_chat_answers_directly_unless_thinking_is_turned_on(
    chat_client: httpx.AsyncClient,
) -> None:
    app = app_of(chat_client)
    seen: list[Any] = []
    original = app.state.ai.stream

    async def spy(*args: Any, **kwargs: Any) -> Any:
        seen.append(kwargs.get("thinking"))
        return await original(*args, **kwargs)

    app.state.ai.stream = spy
    settings = (await chat_client.get("/api/ai/settings")).json()
    assert settings["chat_thinking"] is False  # fast by default

    async def ask(text: str) -> None:
        cid = await open_chat(chat_client, department="sales")
        await chat_client.post(f"/api/conversations/{cid}/messages", data={"content": text})
        for _ in range(200):
            if cid not in app.state.chat.replies:
                return
            await asyncio.sleep(0.02)

    await ask("Who is on your team?")
    r = await chat_client.patch("/api/ai/settings", json={"chat_thinking": True})
    assert r.status_code == 200 and r.json()["chat_thinking"] is True
    await ask("And who leads it?")
    assert seen == [False, True]
