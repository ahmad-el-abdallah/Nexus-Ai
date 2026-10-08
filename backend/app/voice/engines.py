"""Local speech engines: faster-whisper (speech → text) and Piper (text → speech).

Engines are synchronous and CPU-bound; the voice service runs them in a worker
thread. The fake engines exist only for automated tests (NEXUS_VOICE_FAKE with
NEXUS_ENV=test) so the suite never needs the 200+ MB models.
"""

from __future__ import annotations

import io
import os
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np

SAMPLE_RATE = 16_000


class AudioError(Exception):
    """The recording couldn't be decoded."""


@dataclass
class Transcript:
    text: str
    language: str | None
    language_probability: float | None
    duration_s: float


def decode_audio(data: bytes) -> np.ndarray:
    """Any container/codec PyAV understands (webm/opus, ogg, wav, mp3, m4a) →
    16 kHz mono float32, the format Whisper expects."""
    import av  # heavy import, only when needed

    try:
        with av.open(io.BytesIO(data)) as container:
            if not container.streams.audio:
                raise AudioError("The recording has no audio track.")
            resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
            parts: list[np.ndarray] = []
            for frame in container.decode(audio=0):
                parts.extend(f.to_ndarray().reshape(-1) for f in resampler.resample(frame))
            parts.extend(f.to_ndarray().reshape(-1) for f in resampler.resample(None))
    except AudioError:
        raise
    except Exception as error:  # PyAV raises many specific error types
        raise AudioError("The recording couldn't be read as audio.") from error
    if not parts:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(parts).astype(np.float32) / 32768.0


class SpeechToText(Protocol):
    def transcribe(self, audio: np.ndarray, language: str | None) -> Transcript: ...


class TextToSpeech(Protocol):
    def synthesize(self, text: str, speaker: int | None, length_scale: float) -> bytes: ...


class WhisperEngine:
    def __init__(self, path: Path) -> None:
        from faster_whisper import WhisperModel

        threads = max(1, min(4, os.cpu_count() or 1))
        self.model = WhisperModel(str(path), device="cpu", compute_type="int8", cpu_threads=threads)

    def transcribe(self, audio: np.ndarray, language: str | None) -> Transcript:
        segments, info = self.model.transcribe(
            audio,
            language=language,
            beam_size=1,
            vad_filter=True,  # skips silence, which also prevents invented text
            condition_on_previous_text=False,
        )
        text = " ".join(s.text.strip() for s in segments).strip()
        return Transcript(
            text=text,
            language=info.language,
            language_probability=round(float(info.language_probability), 3),
            duration_s=round(len(audio) / SAMPLE_RATE, 2),
        )


class PiperEngine:
    def __init__(self, model_path: Path) -> None:
        from piper import PiperVoice

        self.voice = PiperVoice.load(model_path)
        self.speakers = int(self.voice.config.num_speakers or 1)

    def synthesize(self, text: str, speaker: int | None, length_scale: float) -> bytes:
        from piper.config import SynthesisConfig

        config = SynthesisConfig(
            speaker_id=speaker % self.speakers
            if speaker is not None and self.speakers > 1
            else None,
            length_scale=length_scale,
        )
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav:
            self.voice.synthesize_wav(text, wav, syn_config=config)
        return buffer.getvalue()


# ------------------------------------------------------------- test doubles

FAKE_TRANSCRIPT = "This is a voice test for the marketing team."


class FakeSpeechToText:
    """Test double: returns a fixed transcript (Arabic when asked for Arabic)."""

    def transcribe(self, audio: np.ndarray, language: str | None) -> Transcript:
        text = "هذا اختبار صوتي لفريق التسويق." if language == "ar" else FAKE_TRANSCRIPT
        return Transcript(text, language or "en", 1.0, round(len(audio) / SAMPLE_RATE, 2))


class FakeTextToSpeech:
    """Test double: 0.2 s of silence as a valid WAV file."""

    def synthesize(self, text: str, speaker: int | None, length_scale: float) -> bytes:
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(22_050)
            wav.writeframes(b"\x00\x00" * 4_410)
        return buffer.getvalue()
