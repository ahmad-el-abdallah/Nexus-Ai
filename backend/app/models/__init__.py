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
from app.models.employee import Employee, EmployeeStatus
from app.models.system import SystemMetadata
from app.models.task import Task, TaskStatus

__all__ = [
    "AIModel",
    "AIProviderSettings",
    "AIUsage",
    "Attachment",
    "Conversation",
    "ConversationKind",
    "Department",
    "Employee",
    "EmployeeStatus",
    "Message",
    "MessageRole",
    "MessageStatus",
    "SystemMetadata",
    "Task",
    "TaskStatus",
]
