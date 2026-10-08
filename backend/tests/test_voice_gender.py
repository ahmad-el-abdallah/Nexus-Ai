"""Employees speak with a voice and grammar that match their gender; voice input is
English or Arabic only and is never translated."""

from __future__ import annotations

import io
import wave
from types import SimpleNamespace
from typing import Any

import httpx
import numpy as np
import pytest

from app.ai.gateway import system_prompt
from app.core.events import EventBus
from app.voice.engines import WhisperEngine, retune
from app.voice.service import VoiceService
from app.voice.speakers import FEMALE_EN, MALE_EN
from app.voice.voices import ARABIC_FEMALE_PITCH, voice_for


def rate_of(wav_bytes: bytes) -> int:
    with wave.open(io.BytesIO(wav_bytes), "rb") as wav:
        return wav.getframerate()


def test_english_voices_match_gender_and_stay_stable() -> None:
    assert not set(FEMALE_EN) & set(MALE_EN)
    for seed in range(1, 300):
        assert voice_for(seed, "female", "en").speaker in FEMALE_EN
        assert voice_for(seed, "male", "en").speaker in MALE_EN
    assert voice_for(7, "female", "en") == voice_for(7, "female", "en")
    assert voice_for(7, None, "en").speaker == 7  # not set: as before


def test_arabic_voice_is_raised_for_women() -> None:
    assert voice_for(7, "female", "ar").pitch == ARABIC_FEMALE_PITCH > 1
    assert voice_for(7, "male", "ar").pitch == 1.0


def test_retune_keeps_the_audio_and_raises_the_rate() -> None:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(22_050)
        wav.writeframes(b"\x01\x00" * 1000)
    raised = retune(buffer.getvalue(), 1.3)
    assert rate_of(raised) == round(22_050 * 1.3)
    with wave.open(io.BytesIO(raised), "rb") as wav:
        assert wav.readframes(1000) == b"\x01\x00" * 1000
    assert retune(buffer.getvalue(), 1.0) == buffer.getvalue()


async def test_female_employee_speaks_arabic_with_the_raised_voice(make_settings: Any) -> None:
    service = VoiceService(make_settings(NEXUS_VOICE_FAKE=True), EventBus())
    female, _ = await service.synthesize("مرحبا", "ar", 5, 1.0, "female")
    male, _ = await service.synthesize("مرحبا", "ar", 5, 1.0, "male")
    assert rate_of(female) == round(22_050 * ARABIC_FEMALE_PITCH)
    assert rate_of(male) == 22_050


def test_agents_use_their_grammatical_gender_and_only_english_or_arabic() -> None:
    department = SimpleNamespace(name="Sales", description="Sells.", responsibilities=["Sell"])
    woman = SimpleNamespace(name="Priya Nair", role="SDR", department="sales", gender="female")
    man = SimpleNamespace(name="Diego Alvarez", role="AE", department="sales", gender="male")
    unset = SimpleNamespace(name="Joud", role="AE", department="sales", gender=None)
    for employee in (woman, man, unset):
        text = system_prompt(employee, department)  # type: ignore[arg-type]
        assert "write only in English or Arabic" in text
        assert "never translate the owner's words" in text
    assert "You are a woman" in system_prompt(woman, department)  # type: ignore[arg-type]
    assert "أنا سعيدة" in system_prompt(woman, department)  # type: ignore[arg-type]
    assert "You are a man" in system_prompt(man, department)  # type: ignore[arg-type]
    assert "You are a" not in system_prompt(unset, department)  # type: ignore[arg-type]


class StubWhisper:
    def __init__(self, probs: list[tuple[str, float]]) -> None:
        self.probs = probs
        self.calls: list[dict[str, Any]] = []

    def detect_language(self, audio: Any, **_: Any) -> tuple[str, float, list[tuple[str, float]]]:
        best = max(self.probs, key=lambda p: p[1])
        return best[0], best[1], self.probs

    def transcribe(self, audio: Any, **options: Any) -> tuple[list[Any], Any]:
        self.calls.append(options)
        return [SimpleNamespace(text=" نص ")], SimpleNamespace(language=options["language"])


@pytest.mark.parametrize(
    ("probs", "expected"),
    [
        # Short Arabic clips are often scored as Persian or Urdu: still Arabic.
        ([("fa", 0.5), ("ar", 0.3), ("en", 0.2)], "ar"),
        ([("en", 0.7), ("ar", 0.1), ("de", 0.2)], "en"),
    ],
)
def test_speech_is_transcribed_as_english_or_arabic_never_translated(
    probs: list[tuple[str, float]], expected: str
) -> None:
    engine = WhisperEngine.__new__(WhisperEngine)
    engine.model = StubWhisper(probs)  # type: ignore[assignment]
    transcript = engine.transcribe(np.zeros(16_000, dtype=np.float32), None)
    assert transcript.language == expected
    call = engine.model.calls[0]  # type: ignore[attr-defined]
    assert call["language"] == expected and call["task"] == "transcribe"
    # A language chosen in Settings is used as is.
    engine.transcribe(np.zeros(16_000, dtype=np.float32), "ar")
    assert engine.model.calls[1]["language"] == "ar"  # type: ignore[attr-defined]


async def test_employees_have_a_gender_the_owner_can_set(client: httpx.AsyncClient) -> None:
    roster = (await client.get("/api/employees")).json()
    genders = {e["name"]: e["gender"] for e in roster}
    assert genders["Aria Vance"] == "female" and genders["Diego Alvarez"] == "male"
    assert all(g in ("female", "male") for g in genders.values())
    employee = next(e for e in roster if e["name"] == "Diego Alvarez")
    r = await client.patch(f"/api/employees/{employee['id']}", json={"gender": "female"})
    assert r.status_code == 200 and r.json()["gender"] == "female"
    bad = await client.patch(f"/api/employees/{employee['id']}", json={"gender": "robot"})
    assert bad.status_code == 422
    hired = await client.post(
        "/api/employees",
        json={
            "name": "Layla Haddad",
            "department": "sales",
            "role": roster_role(roster),
            "gender": "female",
        },
    )
    assert hired.status_code == 201, hired.text
    assert hired.json()["gender"] == "female"


def roster_role(roster: list[dict[str, Any]]) -> str:
    return next(e["role"] for e in roster if e["department"] == "sales" and e["seniority"] == "mid")
