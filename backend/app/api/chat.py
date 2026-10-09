"""Conversations with the CEO, departments and individual employees."""

from __future__ import annotations

import mimetypes
import posixpath
import re
from datetime import UTC, datetime
from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.db.session import get_session
from app.models import (
    Attachment,
    Conversation,
    ConversationKind,
    Department,
    Employee,
    Message,
    MessageRole,
    MessageStatus,
)
from app.schemas import ConversationOut, MessageOut, MessagePreview, SearchMatch, dump
from app.services.chat import DEFAULT_TITLE, ChatError, ChatService, new_id, title_from

router = APIRouter(prefix="/api", tags=["chat"])
log = get_logger("nexus.chat.api")
Session = Annotated[AsyncSession, Depends(get_session)]

MAX_MESSAGE_CHARS = 16_000
MAX_FILES = 4
MAX_FILE_BYTES = 2 * 1024 * 1024
TEXT_TYPES = {
    "application/json",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/toml",
    "application/javascript",
    "application/sql",
    "image/svg+xml",
}
TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".toml", ".ini",
    ".cfg", ".log", ".xml", ".html", ".htm", ".css", ".js", ".jsx", ".ts", ".tsx", ".py",
    ".sql", ".sh", ".rs", ".go", ".java", ".kt", ".c", ".h", ".cpp", ".rb", ".php", ".svg",
}  # fmt: skip


def chat_service(request: Request) -> ChatService:
    return request.app.state.chat


Chat = Annotated[ChatService, Depends(chat_service)]


def _chat_error(error: ChatError) -> HTTPException:
    return HTTPException(error.status, str(error))


def _snippet(text: str, needle: str | None = None, width: int = 140) -> str:
    """One plain-text line: Markdown marks are dropped for list previews."""
    flat = " ".join(re.sub(r"(\*\*|__|`|~~|^#+\s*)", "", text, flags=re.MULTILINE).split())
    if needle:
        at = flat.lower().find(needle.lower())
        if at > 40:
            flat = "…" + flat[at - 40 :]
    return flat if len(flat) <= width else flat[: width - 1].rstrip() + "…"


def conversation_out(
    chat: ChatService,
    conversation: Conversation,
    counts: dict[str, int],
    latest: dict[str, Message],
    match: SearchMatch | None = None,
) -> ConversationOut:
    out = ConversationOut.model_validate(conversation)
    out.message_count = counts.get(conversation.id, 0)
    last = latest.get(conversation.id)
    if last is not None:
        content = chat.live_content(last.id) if last.status == MessageStatus.STREAMING else None
        text = content if content is not None else last.content
        if not text and last.error:
            text = f"No reply: {last.error}"
        out.last_message = MessagePreview(
            role=last.role, author_name=last.author_name, snippet=_snippet(text), status=last.status
        )
    out.replying = chat.is_replying(conversation.id)
    out.match = match
    return out


async def _conversation(session: AsyncSession, conversation_id: str) -> Conversation:
    conversation = await session.get(Conversation, conversation_id)
    if conversation is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    return conversation


# ----------------------------------------------------------- conversations


class ConversationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: ConversationKind
    employee_id: str | None = None
    department: str | None = None
    title: str | None = Field(default=None, min_length=1, max_length=120)


class ConversationPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=120)


@router.get("/conversations", response_model=list[ConversationOut])
async def list_conversations(
    session: Session,
    chat: Chat,
    q: str | None = None,
    department: str | None = None,
    employee_id: str | None = None,
    limit: int = 100,
) -> list[ConversationOut]:
    """Newest first. `q` searches titles, message text and attachment names."""
    query = select(Conversation)
    if department:
        query = query.where(Conversation.department == department)
    if employee_id:
        query = query.where(Conversation.employee_id == employee_id)
    needle = (q or "").strip()[:200]
    message_hits: dict[str, Message] = {}
    if needle:
        hit = select(Message).where(
            func.lower(Message.content).contains(needle.lower(), autoescape=True)
        )
        file_hit = (
            select(Message.conversation_id)
            .join(Attachment, Attachment.message_id == Message.id)
            .where(func.lower(Attachment.filename).contains(needle.lower(), autoescape=True))
        )
        for m in await session.scalars(hit.order_by(Message.id.desc())):
            message_hits.setdefault(m.conversation_id, m)
        query = query.where(
            or_(
                func.lower(Conversation.title).contains(needle.lower(), autoescape=True),
                Conversation.id.in_(list(message_hits)),
                Conversation.id.in_(file_hit),
            )
        )
    query = query.order_by(
        func.coalesce(Conversation.last_message_at, Conversation.created_at).desc()
    ).limit(max(1, min(limit, 500)))
    conversations = list(await session.scalars(query))
    counts, latest = await chat.summary_extras(session, [c.id for c in conversations])
    out = []
    for c in conversations:
        match = None
        if needle:
            m = message_hits.get(c.id)
            match = (
                SearchMatch(message_id=m.id, snippet=_snippet(m.content, needle))
                if m is not None
                else SearchMatch(message_id=None, snippet=_snippet(c.title, needle))
            )
        out.append(conversation_out(chat, c, counts, latest, match))
    return out


@router.post("/conversations", response_model=ConversationOut, status_code=201)
async def create_conversation(
    body: ConversationCreate, session: Session, chat: Chat
) -> ConversationOut:
    if body.kind == ConversationKind.EMPLOYEE:
        if not body.employee_id or body.department:
            raise HTTPException(
                422, "An employee conversation needs employee_id (and no department)."
            )
        employee = await session.get(Employee, body.employee_id)
        if employee is None:
            raise HTTPException(404, "Employee not found")
        department_key = employee.department
    else:
        if not body.department or body.employee_id:
            raise HTTPException(
                422, "A department conversation needs department (and no employee_id)."
            )
        department = await session.get(Department, body.department)
        if department is None:
            raise HTTPException(404, "Department not found")
        department_key = department.key
    conversation = Conversation(
        id=new_id("cnv"),
        kind=body.kind.value,
        department=department_key,
        employee_id=body.employee_id,
        title=(body.title or DEFAULT_TITLE).strip() or DEFAULT_TITLE,
    )
    session.add(conversation)
    await session.commit()
    await session.refresh(conversation)
    out = conversation_out(chat, conversation, {}, {})
    chat.events.publish("conversation.updated", dump(out))
    return out


@router.get("/conversations/{conversation_id}", response_model=ConversationOut)
async def get_conversation(conversation_id: str, session: Session, chat: Chat) -> ConversationOut:
    conversation = await _conversation(session, conversation_id)
    counts, latest = await chat.summary_extras(session, [conversation.id])
    return conversation_out(chat, conversation, counts, latest)


@router.patch("/conversations/{conversation_id}", response_model=ConversationOut)
async def rename_conversation(
    conversation_id: str, body: ConversationPatch, session: Session, chat: Chat
) -> ConversationOut:
    conversation = await _conversation(session, conversation_id)
    conversation.title = body.title.strip() or conversation.title
    await session.commit()
    await session.refresh(conversation)
    counts, latest = await chat.summary_extras(session, [conversation.id])
    out = conversation_out(chat, conversation, counts, latest)
    chat.events.publish("conversation.updated", dump(out))
    return out


@router.delete("/conversations/{conversation_id}", status_code=204)
async def delete_conversation(conversation_id: str, session: Session, chat: Chat) -> None:
    """Owner action: permanently deletes the conversation, its messages and files.
    Tasks created from it are kept (they lose the link)."""
    conversation = await _conversation(session, conversation_id)
    await chat.stop(conversation.id)
    await session.execute(delete(Conversation).where(Conversation.id == conversation.id))
    await session.commit()
    chat.events.publish("conversation.deleted", {"id": conversation_id})
    log.info("chat.conversation_deleted", conversation_id=conversation_id)


# ---------------------------------------------------------------- messages


@router.get("/conversations/{conversation_id}/messages", response_model=list[MessageOut])
async def list_messages(
    conversation_id: str, session: Session, chat: Chat, before: int | None = None, limit: int = 200
) -> list[MessageOut]:
    """Oldest first; `before` pages back through long conversations."""
    await _conversation(session, conversation_id)
    query = select(Message).where(Message.conversation_id == conversation_id)
    if before is not None:
        query = query.where(Message.id < before)
    rows = list(
        await session.scalars(query.order_by(Message.id.desc()).limit(max(1, min(limit, 500))))
    )
    return [await chat.message_out(session, m) for m in reversed(rows)]


def _readable_text(filename: str, content_type: str, data: bytes) -> str | None:
    extension = posixpath.splitext(filename.lower())[1]
    texty = (
        content_type.startswith("text/")
        or content_type in TEXT_TYPES
        or extension in TEXT_EXTENSIONS
    )
    if not texty or b"\x00" in data[:4096]:
        return None
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None


def _clean_filename(name: str | None) -> str:
    base = posixpath.basename((name or "").replace("\\", "/")).strip()
    base = "".join(ch for ch in base if ch.isprintable() and ch not in '"<>|:*?')
    return (base or "file")[:255]


class SendResult(BaseModel):
    message: MessageOut
    reply: MessageOut | None


@router.post(
    "/conversations/{conversation_id}/messages", response_model=SendResult, status_code=201
)
async def send_message(
    conversation_id: str,
    session: Session,
    chat: Chat,
    content: Annotated[str, Form(max_length=MAX_MESSAGE_CHARS)] = "",
    files: Annotated[list[UploadFile] | None, File()] = None,
    input_mode: Annotated[Literal["text", "voice"], Form()] = "text",
    reply_style: Annotated[Literal["text", "spoken"], Form()] = "text",
) -> SendResult:
    """Stores the owner's message (multipart: `content` + optional `files`;
    `input_mode=voice` when `content` is a reviewed transcript, usually with the
    recording attached) and starts the reply. The reply streams over /api/events.
    `reply_style=spoken` (a live voice session): a short, conversational reply
    without tables or lists, since it is read aloud as it streams."""
    conversation = await _conversation(session, conversation_id)
    uploads = files or []
    text = content.strip()
    if not text and not uploads:
        raise HTTPException(422, "Write a message or attach a file.")
    if input_mode == "voice" and not text:
        raise HTTPException(422, "A voice message needs its transcript.")
    if len(uploads) > MAX_FILES:
        raise HTTPException(422, f"Attach at most {MAX_FILES} files per message.")
    if chat.is_replying(conversation.id):
        raise HTTPException(
            409, "A reply is still being written. Wait for it or stop it, then send."
        )
    # Refuse before storing anything if nobody may answer.
    try:
        await chat.responder(session, conversation)
    except ChatError as error:
        raise _chat_error(error) from error

    stored: list[Attachment] = []
    for upload in uploads:
        data = await upload.read(MAX_FILE_BYTES + 1)
        name = _clean_filename(upload.filename)
        if len(data) > MAX_FILE_BYTES:
            raise HTTPException(
                413, f"“{name}” is larger than {MAX_FILE_BYTES // (1024 * 1024)} MB."
            )
        content_type = (upload.content_type or "").split(";")[0].strip().lower()
        if not content_type or content_type == "application/octet-stream":
            content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
        decoded = _readable_text(name, content_type, data)
        stored.append(
            Attachment(
                id=new_id("att"),
                filename=name,
                content_type=content_type[:120],
                size=len(data),
                readable=decoded is not None,
                text=decoded,
                data=data,
            )
        )

    message = Message(
        conversation_id=conversation.id,
        role=MessageRole.OWNER.value,
        content=text,
        input_mode=input_mode,
        status=MessageStatus.COMPLETE.value,
        finished_at=datetime.now(UTC),
    )
    session.add(message)
    await session.flush()
    for a in stored:
        a.message_id = message.id
        session.add(a)
    if conversation.title == DEFAULT_TITLE:
        conversation.title = title_from(text or stored[0].filename)
    conversation.last_message_at = datetime.now(UTC)
    await session.commit()
    await session.refresh(message)
    if chat.artifacts:
        for attachment in stored:
            try:
                await chat.artifacts.register_attachment(attachment.id)
            except Exception:
                log.exception("chat.artifact_registration_failed", attachment_id=attachment.id)
    owner = await chat.message_out(session, message)
    chat.events.publish("message.created", dump(owner))
    try:
        reply = await chat.start_reply(session, conversation, spoken=reply_style == "spoken")
    except ChatError as error:
        # The routing changed between the check and now (e.g. a suspension).
        log.warning("chat.reply_not_started", conversation_id=conversation.id, reason=str(error))
        return SendResult(message=owner, reply=None)
    return SendResult(message=owner, reply=await chat.message_out(session, reply))


@router.post("/conversations/{conversation_id}/reply", response_model=MessageOut, status_code=201)
async def retry_reply(conversation_id: str, session: Session, chat: Chat) -> MessageOut:
    """Asks for a new reply to the conversation as it stands (e.g. after an error)."""
    conversation = await _conversation(session, conversation_id)
    last = await session.scalar(
        select(Message)
        .where(Message.conversation_id == conversation.id)
        .order_by(Message.id.desc())
    )
    if last is None:
        raise HTTPException(409, "There is nothing to reply to yet.")
    try:
        reply = await chat.start_reply(session, conversation)
    except ChatError as error:
        raise _chat_error(error) from error
    return await chat.message_out(session, reply)


@router.post("/conversations/{conversation_id}/stop")
async def stop_reply(conversation_id: str, session: Session, chat: Chat) -> dict[str, bool]:
    await _conversation(session, conversation_id)
    return {"stopped": await chat.stop(conversation_id)}


# ------------------------------------------------------------- attachments


PLAYABLE_AUDIO = {"audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4"}


@router.get("/attachments/{attachment_id}")
async def download_attachment(attachment_id: str, session: Session, play: bool = False) -> Response:
    """Served as a download, never rendered by the browser. `?play=1` streams
    recognised audio formats inline so voice messages can be played back."""
    attachment = await session.get(Attachment, attachment_id)
    if attachment is None:
        raise HTTPException(404, "Attachment not found")
    inline = play and attachment.content_type in PLAYABLE_AUDIO
    return Response(
        attachment.data,
        media_type=attachment.content_type if inline else "application/octet-stream",
        headers={
            "Content-Disposition": f"{'inline' if inline else 'attachment'}; filename*=UTF-8''{quote(attachment.filename)}",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "Cache-Control": "private, no-store",
        },
    )
