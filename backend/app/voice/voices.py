"""Which voice an employee speaks with: matched to their gender.

English: Piper's LibriTTS-R model has 904 speakers; `speakers.py` lists which are
female and which male (from LibriSpeech's speaker metadata, checked by measuring the
pitch of every voice on this machine). Each employee keeps one voice from their
gender's list.

Arabic: the only local Arabic voice (Kareem) is male, so female employees use it
with a raised pitch — an approximation until a female Arabic voice exists.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.voice.speakers import FEMALE_EN, MALE_EN

ARABIC_FEMALE_PITCH = 1.5  # Kareem ~112 Hz → ~168 Hz


@dataclass(frozen=True)
class VoiceChoice:
    speaker: int | None
    pitch: float = 1.0


def voice_for(seed: int | None, gender: str | None, language: str) -> VoiceChoice:
    if language == "ar":
        return VoiceChoice(None, ARABIC_FEMALE_PITCH if gender == "female" else 1.0)
    if seed is None:
        return VoiceChoice(None)
    pool = FEMALE_EN if gender == "female" else MALE_EN if gender == "male" else None
    return VoiceChoice(pool[seed % len(pool)] if pool else seed)
