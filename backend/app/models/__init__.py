"""Import every model module here so Alembic autogenerate sees all tables."""

from app.models.employee import Employee, EmployeeStatus
from app.models.system import SystemMetadata

__all__ = ["Employee", "EmployeeStatus", "SystemMetadata"]
