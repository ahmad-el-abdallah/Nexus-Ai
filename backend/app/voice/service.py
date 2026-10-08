"""Voice: installing local speech models, transcribing recordings, speaking replies.

Nothing here talks to a cloud speech service. The only network traffic is the
owner-initiated model download from Hugging Face (pinned revision, verified by
size and SHA-256). Audio never leaves the machine.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Environment, Settings
from app.core.events import EventBus
from app.core.logging import get_logger
from app.models import VoiceSettings
from app.voice.catalog import AR_VOICE, DEFAULT_STT, EN_VOICE, MODELS, SpeechModel
from app.voice.engines import (
    SAMPLE_RATE,
    AudioError,
    FakeSpeechToText,
    FakeTextToSpeech,
    PiperEngine,
    SpeechToText,
    TextToSpeech,
    Transcript,
    WhisperEngine,
    decode_audio,
)
from app.voice.voices import voice_for

log = get_logger("nexus.voice")

MAX_RECORDING_SECONDS = 120
MANIFEST = "manifest.json"


class VoiceError(Exception):
    def __init__(self, kind: str, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.kind = kind
        self.status = status


@dataclass
class Install:
    downloaded: int = 0
    total: int = 0
    error: str | None = None
    task: asyncio.Task[None] | None = field(default=None, repr=False)


class VoiceService:
    def __init__(
        self,
        settings: Settings,
        events: EventBus,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if settings.voice_fake and settings.env != Environment.TEST:
            raise RuntimeError("NEXUS_VOICE_FAKE is only allowed with NEXUS_ENV=test.")
        self.fake = settings.voice_fake
        self.root = Path(settings.voice_dir)
        self.events = events
        self.transport = transport
        self.installs: dict[str, Install] = {}
        self._stt: dict[str, SpeechToText] = {}
        self._tts: dict[str, TextToSpeech] = {}
        self._stt_lock = asyncio.Lock()
        self._tts_lock = asyncio.Lock()
        self._load_lock = asyncio.Lock()

    # -------------------------------------------------------------- settings

    async def preferences(self, session: AsyncSession) -> VoiceSettings:
        row = await session.get(VoiceSettings, "default")
        if row is None:
            row = VoiceSettings(
                key="default",
                stt_model=DEFAULT_STT,
                language="auto",
                speak_replies=False,
                muted=False,
                speech_rate=1.0,
            )
            session.add(row)
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                row = await session.get(VoiceSettings, "default", populate_existing=True)
                assert row is not None
                return row
            await session.refresh(row)
        return row

    # ---------------------------------------------------------------- models

    def model_dir(self, model: SpeechModel) -> Path:
        return self.root / model.id

    def installed(self, model_id: str) -> bool:
        if self.fake:
            return True
        model = MODELS.get(model_id)
        return model is not None and (self.model_dir(model) / MANIFEST).is_file()

    def model_status(self, model: SpeechModel) -> dict[str, Any]:
        install = self.installs.get(model.id)
        if self.installed(model.id):
            state = "installed"
        elif install and install.task and not install.task.done():
            state = "downloading"
        elif install and install.error:
            state = "error"
        else:
            state = "not_installed"
        return {
            "id": model.id,
            "kind": model.kind,
            "label": model.label,
            "languages": list(model.languages),
            "size": model.size,
            "license": model.license,
            "source": model.source,
            "description": model.description,
            "speakers": model.speakers,
            "state": state,
            "downloaded": install.downloaded if install and state == "downloading" else None,
            "error": install.error if install and state == "error" else None,
            "loaded": model.id in self._stt or model.id in self._tts,
        }

    def status(self) -> dict[str, Any]:
        return {
            "engine": "fake (tests)" if self.fake else "local",
            "models": [self.model_status(m) for m in MODELS.values()],
        }

    def _publish(self) -> None:
        self.events.publish("voice.updated", self.status())

    async def install(self, model_id: str) -> None:
        model = MODELS.get(model_id)
        if model is None:
            raise VoiceError("unknown_model", "Unknown speech model.", 404)
        if self.installed(model_id):
            return
        current = self.installs.get(model_id)
        if current and current.task and not current.task.done():
            return
        install = Install(total=model.size)
        self.installs[model_id] = install
        install.task = asyncio.create_task(self._download(model, install), name=f"voice-{model_id}")
        self._publish()

    async def _download(self, model: SpeechModel, install: Install) -> None:
        target = self.model_dir(model)
        partial = self.root / f".partial-{model.id}"
        shutil.rmtree(partial, ignore_errors=True)
        partial.mkdir(parents=True)
        last_publish = 0.0
        log.info("voice.download_started", model=model.id, bytes=model.size)
        try:
            timeout = httpx.Timeout(30.0, read=60.0)
            async with httpx.AsyncClient(
                transport=self.transport, follow_redirects=True, timeout=timeout
            ) as client:
                for file in model.files:
                    digest = hashlib.sha256()
                    written = 0
                    async with client.stream("GET", model.url(file)) as response:
                        if response.status_code != 200:
                            raise VoiceError(
                                "download_failed",
                                f"Download of {file.name} failed (HTTP {response.status_code}).",
                            )
                        with (partial / file.name).open("wb") as out:
                            async for chunk in response.aiter_bytes(1 << 16):
                                out.write(chunk)
                                digest.update(chunk)
                                written += len(chunk)
                                install.downloaded += len(chunk)
                                if written > file.size:
                                    raise VoiceError(
                                        "verify_failed", f"{file.name} is larger than expected."
                                    )
                                if time.monotonic() - last_publish > 0.5:
                                    last_publish = time.monotonic()
                                    self._publish()
                    if written != file.size or digest.hexdigest() != file.sha256:
                        raise VoiceError(
                            "verify_failed",
                            f"{file.name} failed verification (size or SHA-256 mismatch).",
                        )
            (partial / MANIFEST).write_text(
                json.dumps(
                    {
                        "id": model.id,
                        "repo": model.repo,
                        "revision": model.revision,
                        "files": {f.name: f.sha256 for f in model.files},
                    },
                    indent=2,
                )
            )
            shutil.rmtree(target, ignore_errors=True)
            partial.rename(target)
            install.error = None
            log.info("voice.download_finished", model=model.id)
        except asyncio.CancelledError:
            shutil.rmtree(partial, ignore_errors=True)
            raise
        except VoiceError as error:
            install.error = str(error)
            shutil.rmtree(partial, ignore_errors=True)
            log.warning("voice.download_failed", model=model.id, reason=str(error))
        except (httpx.HTTPError, OSError) as error:
            install.error = f"Download failed: {type(error).__name__}. Check the internet connection and try again."
            shutil.rmtree(partial, ignore_errors=True)
            log.warning("voice.download_failed", model=model.id, reason=type(error).__name__)
        finally:
            self._publish()

    async def remove(self, model_id: str) -> None:
        model = MODELS.get(model_id)
        if model is None:
            raise VoiceError("unknown_model", "Unknown speech model.", 404)
        install = self.installs.pop(model_id, None)
        if install and install.task and not install.task.done():
            install.task.cancel()
        async with self._load_lock:
            self._stt.pop(model_id, None)
            self._tts.pop(model_id, None)
        if not self.fake:
            shutil.rmtree(self.model_dir(model), ignore_errors=True)
        log.info("voice.model_removed", model=model_id)
        self._publish()

    # --------------------------------------------------------------- engines

    async def _stt_engine(self, model_id: str) -> SpeechToText:
        if self.fake:
            return FakeSpeechToText()
        if not self.installed(model_id):
            raise VoiceError(
                "not_installed",
                "Speech recognition isn't installed yet. Install a Whisper model in Settings → Voice.",
            )
        async with self._load_lock:
            if model_id not in self._stt:
                model = MODELS[model_id]
                self._stt[model_id] = await asyncio.to_thread(WhisperEngine, self.model_dir(model))
                self._publish()
            return self._stt[model_id]

    async def _tts_engine(self, model_id: str) -> TextToSpeech:
        if self.fake:
            return FakeTextToSpeech()
        if not self.installed(model_id):
            language = "Arabic" if model_id == AR_VOICE else "English"
            raise VoiceError(
                "not_installed",
                f"The {language} voice isn't installed. Install it in Settings → Voice.",
            )
        async with self._load_lock:
            if model_id not in self._tts:
                model = MODELS[model_id]
                onnx = next(f for f in model.files if f.name.endswith(".onnx"))
                self._tts[model_id] = await asyncio.to_thread(
                    PiperEngine, self.model_dir(model) / onnx.name
                )
                self._publish()
            return self._tts[model_id]

    # ------------------------------------------------------------ operations

    async def transcribe(
        self, audio: bytes, language: str | None, model_id: str
    ) -> tuple[Transcript, int, str]:
        """Returns the transcript, processing time (ms) and the model used."""
        if model_id not in MODELS or MODELS[model_id].kind != "stt":
            model_id = DEFAULT_STT
        if not self.installed(model_id):
            # Fall back to any installed recognition model rather than refusing.
            model_id = next(
                (m for m in MODELS if MODELS[m].kind == "stt" and self.installed(m)), model_id
            )
        engine = await self._stt_engine(model_id)
        try:
            samples = await asyncio.to_thread(decode_audio, audio)
        except AudioError as error:
            raise VoiceError("audio", str(error), 422) from error
        if len(samples) < SAMPLE_RATE * 0.3:
            raise VoiceError(
                "too_short", "The recording is too short — hold the mic a little longer.", 422
            )
        if len(samples) > SAMPLE_RATE * MAX_RECORDING_SECONDS:
            raise VoiceError(
                "too_long", f"Recordings can be at most {MAX_RECORDING_SECONDS} seconds.", 413
            )
        started = time.perf_counter()
        async with self._stt_lock:  # one CPU-heavy transcription at a time
            transcript = await asyncio.to_thread(engine.transcribe, samples, language)
        return transcript, int((time.perf_counter() - started) * 1000), model_id

    async def synthesize(
        self,
        text: str,
        language: str,
        speaker: int | None,
        speech_rate: float,
        gender: str | None = None,
    ) -> tuple[bytes, str]:
        """`speaker` is the employee's voice seed; the voice matches their `gender`."""
        voice = AR_VOICE if language == "ar" else EN_VOICE
        choice = voice_for(speaker, gender, language)
        engine = await self._tts_engine(voice)
        async with self._tts_lock:
            audio = await asyncio.to_thread(
                engine.synthesize, text, choice.speaker, speech_rate, choice.pitch
            )
        return audio, voice

    async def shutdown(self) -> None:
        for install in self.installs.values():
            if install.task and not install.task.done():
                install.task.cancel()
