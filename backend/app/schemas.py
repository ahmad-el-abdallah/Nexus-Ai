"""Response models shared by the REST API and the live event stream."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict

from app.models import EmployeeStatus


class EmployeeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    role: str
    department: str
    seniority: str
    desk_id: str | None
    supervisor_id: str | None
    model_id: str | None
    avatar_seed: int
    gender: str | None = None
    status: EmployeeStatus
    status_detail: str | None
    status_changed_at: datetime


class AttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    filename: str
    content_type: str
    size: int
    readable: bool
    # True when only the beginning of the file fits in the model's context.
    truncated: bool = False


class MessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    conversation_id: str
    created_at: datetime
    role: str
    employee_id: str | None
    author_name: str | None
    author_role: str | None
    author_department: str | None
    content: str
    input_mode: str = "text"
    status: str
    error: str | None
    error_kind: str | None
    model: str | None
    model_source: str | None
    prompt_tokens: int | None
    completion_tokens: int | None
    reasoning_tokens: int | None
    first_token_ms: int | None
    latency_ms: int | None
    context_messages: int | None
    finished_at: datetime | None
    attachments: list[AttachmentOut] = []


class MessagePreview(BaseModel):
    role: str
    author_name: str | None
    snippet: str
    status: str


class SearchMatch(BaseModel):
    message_id: int | None
    snippet: str


class ConversationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    kind: str
    department: str
    employee_id: str | None
    title: str
    created_at: datetime
    last_message_at: datetime | None
    message_count: int = 0
    last_message: MessagePreview | None = None
    # A reply is being generated right now.
    replying: bool = False
    match: SearchMatch | None = None


class TaskOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    description: str
    department: str
    assignee_id: str | None
    status: str
    source_conversation_id: str | None
    source_message_id: int | None
    created_at: datetime | None
    updated_at: datetime | None
    # Workflow tasks (Stage 8)
    kind: str = "manual"
    workflow_id: str | None = None
    parent_id: str | None = None
    depends_on: list[str] = []
    position: int = 0
    attempts: int = 0
    revisions: int = 0
    result: str | None = None
    review_notes: str | None = None
    error: str | None = None
    calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    started_at: datetime | None = None
    finished_at: datetime | None = None


def dump(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(mode="json")
