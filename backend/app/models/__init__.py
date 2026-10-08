"""Import every model module here so Alembic autogenerate sees all tables."""

from app.models.department import Department
from app.models.employee import Employee, EmployeeStatus
from app.models.system import SystemMetadata

__all__ = ["Department", "Employee", "EmployeeStatus", "SystemMetadata"]
