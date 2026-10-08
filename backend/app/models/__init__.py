"""Import every model module here so Alembic autogenerate sees all tables."""

from app.models.ai import AIModel, AIProviderSettings, AIUsage
from app.models.chat import (
    Attachment,
    Conversation,
    ConversationKind,
    Message,
    MessageRole,
    MessageStatus,
)
from app.models.department import Department
from app.models.email import EmailAccount, EmailEvent, EmailMessage, EmailStatus
from app.models.employee import Employee, EmployeeStatus
from app.models.system import SystemMetadata
from app.models.task import TERMINAL, Task, TaskStatus
from app.models.voice import VoiceSettings
from app.models.workflow import FINISHED, Workflow, WorkflowEvent, WorkflowStatus

__all__ = [
    "FINISHED",
    "TERMINAL",
    "AIModel",
    "AIProviderSettings",
    "AIUsage",
    "Attachment",
    "Conversation",
    "ConversationKind",
    "Department",
    "EmailAccount",
    "EmailEvent",
    "EmailMessage",
    "EmailStatus",
    "Employee",
    "EmployeeStatus",
    "Message",
    "MessageRole",
    "MessageStatus",
    "SystemMetadata",
    "Task",
    "TaskStatus",
    "VoiceSettings",
    "Workflow",
    "WorkflowEvent",
    "WorkflowStatus",
]
