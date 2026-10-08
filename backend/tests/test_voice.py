"""Voice: model installs (verified), transcription, speech, settings, voice messages."""

from __future__ import annotations

import asyncio
import difflib
import hashlib
import io
import json
import math
import os
import re
import wave
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.core.config import Environment
from app.core.events import EventBus
from app.main import create_app
from app.voice.catalog import MODELS, ModelFile, SpeechModel
from app.voice.engines import FAKE_TRANSCRIPT
from app.voice.service import VoiceService
from app.voice.text import chunks, language_of, speakable
from tests.test_ai import FAKE_KEY, MASTER, FakeProvider, _no_sleep, ready_catalog


def tone_wav(seconds: float = 1.0, rate: int = 16_000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = bytearray()
        for i in range(int(seconds * rate)):
            value = int(8000 * math.sin(2 * math.pi * 440 * i / rate))
            frames += value.to_bytes(2, "little", signed=True)
        w.writeframes(bytes(frames))
    return buffer.getvalue()


@pytest.fixture
def fake() -> FakeProvider:
    return FakeProvider()


async def _client(app: Any) -> AsyncIterator[httpx.AsyncClient]:
    async with app.router.lifespan_context(app):
        app.state.ai.sleep = _no_sleep
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as http:
            http.app = app  # type: ignore[attr-defined]
            yield http


@pytest.fixture
async def voice_client(
    migrated_db_url: str, make_settings: Any, fake: FakeProvider, tmp_path: Path
) -> AsyncIterator[httpx.AsyncClient]:
    """Fake speech engines (as in e2e) and the fake AI provider."""
    settings = make_settings(
        NEXUS_DATABASE_URL=migrated_db_url,
        NVIDIA_API_KEY=FAKE_KEY,
        NEXUS_SECRET_KEY=MASTER,
        NEXUS_VOICE_FAKE=True,
        NEXUS_VOICE_DIR=str(tmp_path / "voice"),
    )
    app = create_app(settings, ai_transport=httpx.MockTransport(fake.handler))
    async for http in _client(app):
        yield http


@pytest.fixture
def downloads() -> dict[str, bytes]:
    return {}


@pytest.fixture
async def real_client(
    migrated_db_url: str, make_settings: Any, tmp_path: Path, downloads: dict[str, bytes]
) -> AsyncIterator[httpx.AsyncClient]:
    """Real engines, empty model folder, downloads served from `downloads`."""

    async def handler(request: httpx.Request) -> httpx.Response:
        body = downloads.get(str(request.url))
        return httpx.Response(200, content=body) if body is not None else httpx.Response(404)

    settings = make_settings(
        NEXUS_DATABASE_URL=migrated_db_url, NEXUS_VOICE_DIR=str(tmp_path / "voice")
    )
    app = create_app(settings, voice_transport=httpx.MockTransport(handler))
    async for http in _client(app):
        yield http


async def wait_installed(client: httpx.AsyncClient, model_id: str) -> dict[str, Any]:
    for _ in range(100):
        models = {m["id"]: m for m in (await client.get("/api/voice")).json()["models"]}
        if models[model_id]["state"] in ("installed", "error"):
            return models[model_id]
        await asyncio.sleep(0.02)
    raise AssertionError("install did not finish")


# ----------------------------------------------------------- catalogue/settings


async def test_overview_lists_pinned_models_and_defaults(real_client: httpx.AsyncClient) -> None:
    data = (await real_client.get("/api/voice")).json()
    assert data["engine"] == "local"
    assert data["settings"] == {
        "stt_model": "whisper-base",
        "language": "auto",
        "speak_replies": False,
        "muted": False,
        "speech_rate": 1.0,
    }
    states = {m["id"]: m["state"] for m in data["models"]}
    assert states == {
        "whisper-base": "not_installed",
        "whisper-small": "not_installed",
        "piper-en_US-libritts_r-medium": "not_installed",
        "piper-ar_JO-kareem-medium": "not_installed",
    }
    for model in MODELS.values():
        assert len(model.revision) == 40  # pinned commit, never "main"
        assert all(len(f.sha256) == 64 for f in model.files)
    health = (await real_client.get("/api/health/ready")).json()["components"]["voice"]
    assert health["status"] == "not_configured"


async def test_settings_are_validated_and_saved(real_client: httpx.AsyncClient) -> None:
    bad = [{"stt_model": "whisper-huge"}, {"language": "fr"}, {"speech_rate": 3}, {"x": 1}]
    for body in bad:
        assert (await real_client.patch("/api/voice/settings", json=body)).status_code == 422
    r = await real_client.patch(
        "/api/voice/settings",
        json={"language": "ar", "speak_replies": True, "muted": True, "stt_model": "whisper-small"},
    )
    assert r.status_code == 200
    assert r.json()["settings"]["language"] == "ar"
    again = (await real_client.get("/api/voice")).json()["settings"]
    assert again["speak_replies"] is True and again["muted"] is True
    assert again["stt_model"] == "whisper-small"


async def test_missing_models_give_clear_errors(real_client: httpx.AsyncClient) -> None:
    r = await real_client.post("/api/voice/transcribe", files={"audio": ("a.wav", tone_wav())})
    assert r.status_code == 409
    assert r.json()["detail"]["kind"] == "not_installed"
    assert "Settings → Voice" in r.json()["detail"]["message"]
    r = await real_client.post("/api/voice/speak", json={"text": "مرحبا بكم"})
    assert r.status_code == 409
    assert "Arabic voice" in r.json()["detail"]["message"]


# --------------------------------------------------------------- installs


def _tiny_model(monkeypatch: pytest.MonkeyPatch, content: bytes) -> SpeechModel:
    model = SpeechModel(
        id="test-tiny",
        kind="tts",
        label="Tiny",
        languages=("en",),
        repo="acme/tiny",
        revision="0" * 40,
        files=(ModelFile("voice.onnx", len(content), hashlib.sha256(content).hexdigest()),),
        license="test",
        source="test",
        description="test",
    )
    monkeypatch.setitem(MODELS, model.id, model)
    return model


async def test_install_downloads_verifies_and_removes(
    real_client: httpx.AsyncClient,
    downloads: dict[str, bytes],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    content = b"model-bytes" * 1000
    model = _tiny_model(monkeypatch, content)
    downloads[model.url(model.files[0])] = content
    r = await real_client.post(f"/api/voice/models/{model.id}/install")
    assert r.status_code == 202
    status = await wait_installed(real_client, model.id)
    assert status["state"] == "installed"
    folder = tmp_path / "voice" / model.id
    assert (folder / "voice.onnx").read_bytes() == content
    manifest = json.loads((folder / "manifest.json").read_text())
    assert manifest["revision"] == "0" * 40
    assert not list((tmp_path / "voice").glob(".partial-*"))

    r = await real_client.delete(f"/api/voice/models/{model.id}")
    assert {m["id"]: m["state"] for m in r.json()["models"]}[model.id] == "not_installed"
    assert not folder.exists()


async def test_tampered_download_is_rejected(
    real_client: httpx.AsyncClient,
    downloads: dict[str, bytes],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    model = _tiny_model(monkeypatch, b"genuine-bytes")
    downloads[model.url(model.files[0])] = b"tampered-byte"  # same size, wrong hash
    await real_client.post(f"/api/voice/models/{model.id}/install")
    status = await wait_installed(real_client, model.id)
    assert status["state"] == "error"
    assert "verification" in status["error"]
    assert not (tmp_path / "voice" / model.id).exists()


async def test_unreachable_download_reports_an_error(
    real_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    model = _tiny_model(monkeypatch, b"x")
    await real_client.post(f"/api/voice/models/{model.id}/install")
    status = await wait_installed(real_client, model.id)
    assert status["state"] == "error"
    assert "HTTP 404" in status["error"]
    assert (await real_client.post("/api/voice/models/nope/install")).status_code == 404


def test_fake_engines_are_refused_outside_tests(make_settings: Any) -> None:
    settings = make_settings(NEXUS_VOICE_FAKE=True, NEXUS_ENV="development")
    assert settings.env == Environment.DEVELOPMENT
    with pytest.raises(RuntimeError, match="only allowed"):
        VoiceService(settings, EventBus())


# ---------------------------------------------------- transcribe / speak


async def test_transcription(voice_client: httpx.AsyncClient) -> None:
    r = await voice_client.post("/api/voice/transcribe", files={"audio": ("a.wav", tone_wav())})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["text"] == FAKE_TRANSCRIPT
    assert body["duration_s"] == 1.0
    assert body["model"] == "whisper-base"
    ar = await voice_client.post(
        "/api/voice/transcribe", files={"audio": ("a.wav", tone_wav())}, data={"language": "ar"}
    )
    assert ar.json()["language"] == "ar"


async def test_bad_recordings_are_explained(voice_client: httpx.AsyncClient) -> None:
    short = await voice_client.post(
        "/api/voice/transcribe", files={"audio": ("a.wav", tone_wav(0.1))}
    )
    assert short.status_code == 422
    assert short.json()["detail"]["kind"] == "too_short"
    junk = await voice_client.post(
        "/api/voice/transcribe", files={"audio": ("a.webm", b"not audio at all")}
    )
    assert junk.status_code == 422
    assert junk.json()["detail"]["kind"] == "audio"
    empty = await voice_client.post("/api/voice/transcribe", files={"audio": ("a.wav", b"")})
    assert empty.status_code == 422
    big = await voice_client.post(
        "/api/voice/transcribe", files={"audio": ("a.wav", b"x" * (10 * 1024 * 1024 + 1))}
    )
    assert big.status_code == 413


async def test_speech_uses_the_employee_voice(voice_client: httpx.AsyncClient) -> None:
    roster = (await voice_client.get("/api/employees")).json()
    elena = next(e for e in roster if e["name"] == "Elena Rossi")
    r = await voice_client.post(
        "/api/voice/speak", json={"text": "Hello there.", "employee_id": elena["id"]}
    )
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    assert r.headers["x-voice-model"] == "piper-en_US-libritts_r-medium"
    with wave.open(io.BytesIO(r.content)) as w:
        assert w.getnframes() > 0
    ar = await voice_client.post("/api/voice/speak", json={"text": "مرحبا، كيف يمكنني المساعدة؟"})
    assert ar.headers["x-voice-model"] == "piper-ar_JO-kareem-medium"
    too_long = await voice_client.post("/api/voice/speak", json={"text": "x" * 601})
    assert too_long.status_code == 422


# ----------------------------------------------------------- voice messages


async def test_voice_message_reaches_the_right_employee_with_context(
    voice_client: httpx.AsyncClient, fake: FakeProvider
) -> None:
    await ready_catalog(voice_client)
    r = await voice_client.post(
        "/api/conversations", json={"kind": "department", "department": "marketing"}
    )
    cid = r.json()["id"]
    sent = await voice_client.post(
        f"/api/conversations/{cid}/messages",
        data={"content": FAKE_TRANSCRIPT, "input_mode": "voice"},
        files=[("files", ("voice-message.webm", b"\x1aE\xdf\xa3webm", "audio/webm"))],
    )
    assert sent.status_code == 201, sent.text
    owner = sent.json()["message"]
    assert owner["input_mode"] == "voice"
    reply = voice_client.app.state.chat.replies.get(cid)  # type: ignore[attr-defined]
    if reply and reply.task:
        await reply.task
    messages = (await voice_client.get(f"/api/conversations/{cid}/messages")).json()
    assert messages[-1]["author_name"] == "Elena Rossi"
    assert messages[-1]["status"] == "complete"
    prompt = json.loads(fake.calls[-1].content)["messages"]
    assert prompt[-1]["content"].startswith("[Voice message, transcribed automatically")
    assert FAKE_TRANSCRIPT in prompt[-1]["content"]
    assert "voice-message.webm" not in prompt[-1]["content"]
    assert "Reply in the language of the owner's latest message" in prompt[0]["content"]

    audio = owner["attachments"][0]["id"]
    played = await voice_client.get(f"/api/attachments/{audio}?play=1")
    assert played.headers["content-type"] == "audio/webm"
    assert played.headers["content-disposition"].startswith("inline;")
    download = await voice_client.get(f"/api/attachments/{audio}")
    assert download.headers["content-type"] == "application/octet-stream"

    plan = (await voice_client.get(f"/api/voice/messages/{messages[-1]['id']}/speech")).json()
    assert plan["parts"] == [{"text": "Hello from the fake.", "language": "en"}]
    assert plan["speaker"] is not None
    assert (await voice_client.get(f"/api/voice/messages/{owner['id']}/speech")).status_code == 404

    blank = await voice_client.post(
        f"/api/conversations/{cid}/messages",
        data={"content": " ", "input_mode": "voice"},
        files=[("files", ("v.webm", b"x", "audio/webm"))],
    )
    assert blank.status_code == 422


# ----------------------------------------------------------- text for speech


def test_speakable_text() -> None:
    md = "## Plan\n- **Audit** channels\n- See [the brief](https://x.example.com)\n```py\nprint(1)\n```\nDone"
    assert speakable(md) == "Plan. Audit channels. See the brief. (code omitted). Done."
    assert language_of("مرحبا بكم في الشركة") == "ar"
    assert language_of("Hello team") == "en"
    assert language_of("Use API keys بأمان") == "en"
    parts = chunks("One. " * 200, limit=50)
    assert all(len(p) <= 50 for p in parts)
    assert "".join(parts).replace(" ", "") == ("One." * 200)


# ------------------------------------------------- real engines (opt-in)

REAL = os.environ.get("NEXUS_TEST_VOICE_MODELS")


@pytest.mark.skipif(not REAL, reason="set NEXUS_TEST_VOICE_MODELS to a folder of installed models")
async def test_real_round_trip_english_and_arabic(make_settings: Any) -> None:
    """Piper speaks a sentence; Whisper must transcribe it back (both languages)."""
    service = VoiceService(make_settings(NEXUS_VOICE_DIR=REAL), EventBus())
    for language, text in (
        ("en", "Please prepare the marketing plan for the product launch next Friday."),
        ("ar", "من فضلك جهز خطة التسويق لإطلاق المنتج يوم الجمعة القادم."),
    ):
        audio, _ = await service.synthesize(text, language, speaker=42, speech_rate=1.0)
        transcript, _, _ = await service.transcribe(audio, None, "whisper-base")
        assert transcript.language == language
        # Recognition is good, not perfect: require a high word-level match.
        said, heard = (re.sub(r"[^\w\s]", "", t).lower().split() for t in (text, transcript.text))
        ratio = difflib.SequenceMatcher(None, said, heard).ratio()
        assert ratio >= 0.85, (ratio, transcript.text)


# ------------------------------------------------- face-to-face voice sessions


async def test_spoken_replies_are_short_and_plain(
    voice_client: httpx.AsyncClient, fake: FakeProvider
) -> None:
    await ready_catalog(voice_client)
    roster = (await voice_client.get("/api/employees")).json()
    employee = next(e for e in roster if e["name"] == "Priya Nair")
    cid = (
        await voice_client.post(
            "/api/conversations", json={"kind": "employee", "employee_id": employee["id"]}
        )
    ).json()["id"]
    r = await voice_client.post(
        f"/api/conversations/{cid}/messages",
        data={"content": "How is the team doing?", "reply_style": "spoken"},
    )
    assert r.status_code in (200, 201), r.text
    for _ in range(200):
        if cid not in voice_client.app.state.chat.replies:  # type: ignore[attr-defined]
            break
        await asyncio.sleep(0.02)
    system = json.loads(fake.calls[-1].content)["messages"][0]["content"]
    assert "face to face in a live voice conversation" in system
    assert "no tables, lists, bullet points" in system
    # A typed message keeps the normal style.
    await voice_client.post(f"/api/conversations/{cid}/messages", data={"content": "Thanks"})
    for _ in range(200):
        if cid not in voice_client.app.state.chat.replies:  # type: ignore[attr-defined]
            break
        await asyncio.sleep(0.02)
    system = json.loads(fake.calls[-1].content)["messages"][0]["content"]
    assert "face to face" not in system


async def test_streamed_sentences_are_cleaned_before_speaking(
    voice_client: httpx.AsyncClient,
) -> None:
    r = await voice_client.post(
        "/api/voice/speak",
        json={"text": "**Sales** is up. See [report](https://x.example.com)", "clean": True},
    )
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    nothing = await voice_client.post("/api/voice/speak", json={"text": "|---|---|", "clean": True})
    assert nothing.status_code == 204
