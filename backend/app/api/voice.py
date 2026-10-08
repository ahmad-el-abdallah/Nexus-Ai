"""Voice: local speech models, settings, transcription and spoken replies."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.db.session import get_session
from app.models import Employee, Message, MessageRole
from app.voice.catalog import MODELS, STT_MODELS
from app.voice.service import VoiceError, VoiceService
from app.voice.text import chunks, language_of, speakable
from app.voice.voices import voice_for

router = APIRouter(prefix="/api/voice", tags=["voice"])
log = get_logger("nexus.voice.api")
Session = Annotated[AsyncSession, Depends(get_session)]

MAX_AUDIO_BYTES = 10 * 1024 * 1024
MAX_SPEAK_CHARS = 600


def voice_service(request: Request) -> VoiceService:
    return request.app.state.voice


Voice = Annotated[VoiceService, Depends(voice_service)]


def _error(error: VoiceError) -> HTTPException:
    return HTTPException(error.status, {"kind": error.kind, "message": str(error)})


class VoicePreferences(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    stt_model: str
    language: Literal["auto", "en", "ar"]
    speak_replies: bool
    muted: bool
    speech_rate: float


class VoicePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    stt_model: str | None = None
    language: Literal["auto", "en", "ar"] | None = None
    speak_replies: bool | None = None
    muted: bool | None = None
    speech_rate: float | None = Field(default=None, ge=0.6, le=1.6)


async def _overview(session: AsyncSession, voice: VoiceService) -> dict[str, Any]:
    prefs = await voice.preferences(session)
    return {
        "settings": VoicePreferences.model_validate(prefs).model_dump(),
        **voice.status(),
    }


@router.get("")
async def overview(session: Session, voice: Voice) -> dict[str, Any]:
    return await _overview(session, voice)


@router.patch("/settings")
async def update_settings(body: VoicePatch, session: Session, voice: Voice) -> dict[str, Any]:
    prefs = await voice.preferences(session)
    fields = body.model_fields_set
    if "stt_model" in fields and body.stt_model is not None:
        if body.stt_model not in STT_MODELS:
            raise HTTPException(422, "Unknown speech recognition model.")
        prefs.stt_model = body.stt_model
    for name in ("language", "speak_replies", "muted", "speech_rate"):
        if name in fields and getattr(body, name) is not None:
            setattr(prefs, name, getattr(body, name))
    await session.commit()
    await session.refresh(prefs)
    out = await _overview(session, voice)
    voice.events.publish("voice.settings", out["settings"])
    return out


@router.post("/models/{model_id}/install", status_code=202)
async def install_model(model_id: str, session: Session, voice: Voice) -> dict[str, Any]:
    """Owner action: downloads one model (pinned revision, verified by SHA-256)."""
    try:
        await voice.install(model_id)
    except VoiceError as error:
        raise _error(error) from error
    return await _overview(session, voice)


@router.delete("/models/{model_id}")
async def remove_model(model_id: str, session: Session, voice: Voice) -> dict[str, Any]:
    try:
        await voice.remove(model_id)
    except VoiceError as error:
        raise _error(error) from error
    return await _overview(session, voice)


class TranscriptOut(BaseModel):
    text: str
    language: str | None
    language_probability: float | None
    duration_s: float
    processing_ms: int
    model: str


@router.post("/transcribe", response_model=TranscriptOut)
async def transcribe(
    session: Session,
    voice: Voice,
    audio: Annotated[UploadFile, File()],
    language: Annotated[Literal["auto", "en", "ar"] | None, Form()] = None,
) -> TranscriptOut:
    """Speech → text on this machine. The recording isn't stored here; it is
    kept only if the owner sends it with the message."""
    data = await audio.read(MAX_AUDIO_BYTES + 1)
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "The recording is larger than 10 MB.")
    if not data:
        raise HTTPException(422, "The recording is empty.")
    prefs = await voice.preferences(session)
    chosen = language or prefs.language
    try:
        transcript, ms, model = await voice.transcribe(
            data, None if chosen == "auto" else chosen, prefs.stt_model
        )
    except VoiceError as error:
        raise _error(error) from error
    except Exception as error:  # an engine crash must not take the request down silently
        log.exception("voice.transcribe_failed")
        raise HTTPException(
            500, {"kind": "engine_error", "message": "Speech recognition failed."}
        ) from error
    log.info(
        "voice.transcribed",
        model=model,
        seconds=transcript.duration_s,
        ms=ms,
        language=transcript.language,
    )
    return TranscriptOut(
        text=transcript.text,
        language=transcript.language,
        language_probability=transcript.language_probability,
        duration_s=transcript.duration_s,
        processing_ms=ms,
        model=model,
    )


class SpeechPart(BaseModel):
    text: str
    language: str


class SpeechPlan(BaseModel):
    message_id: int
    employee_id: str | None
    speaker: int | None
    parts: list[SpeechPart]


@router.get("/messages/{message_id}/speech", response_model=SpeechPlan)
async def speech_plan(message_id: int, session: Session) -> SpeechPlan:
    """What would be read aloud for an agent reply, split for quick playback."""
    message = await session.get(Message, message_id)
    if message is None or message.role != MessageRole.AGENT:
        raise HTTPException(404, "Agent message not found")
    employee = await session.get(Employee, message.employee_id) if message.employee_id else None
    parts = [
        SpeechPart(text=chunk, language=language_of(chunk))
        for chunk in chunks(speakable(message.content))
    ]
    return SpeechPlan(
        message_id=message.id,
        employee_id=message.employee_id,
        speaker=voice_for(employee.avatar_seed, employee.gender, "en").speaker
        if employee
        else None,
        parts=parts,
    )


class SpeakIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=MAX_SPEAK_CHARS)
    language: Literal["en", "ar"] | None = None
    employee_id: str | None = None


@router.post("/speak")
async def speak(body: SpeakIn, session: Session, voice: Voice) -> Response:
    """Text → speech (WAV) on this machine, in the employee's own voice."""
    prefs = await voice.preferences(session)
    speaker = gender = None
    if body.employee_id:
        employee = await session.get(Employee, body.employee_id)
        if employee:
            speaker, gender = employee.avatar_seed, employee.gender
    language = body.language or language_of(body.text)
    try:
        audio, model = await voice.synthesize(
            body.text, language, speaker, prefs.speech_rate, gender
        )
    except VoiceError as error:
        raise _error(error) from error
    except Exception as error:
        log.exception("voice.speak_failed")
        raise HTTPException(
            500, {"kind": "engine_error", "message": "Speech synthesis failed."}
        ) from error
    return Response(
        audio,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store", "X-Voice-Model": model},
    )


def voice_status_for_health(voice: VoiceService) -> tuple[str, str, dict[str, Any]]:
    stt = [m for m in MODELS.values() if m.kind == "stt" and voice.installed(m.id)]
    tts = [m for m in MODELS.values() if m.kind == "tts" and voice.installed(m.id)]
    data = {
        "stt": [m.id for m in stt],
        "tts": [m.id for m in tts],
        "engine": voice.status()["engine"],
    }
    if stt:
        return "ok", f"{len(stt)} recognition model(s), {len(tts)} voice(s) installed", data
    return "not_configured", "No speech model installed — Settings → Voice", data
