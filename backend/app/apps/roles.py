"""Who does what in an app build: decided here from each person's role, never by a model.

Engineers get the files of their own area; when nobody with the fitting role is
available the next role in the list steps in, and finally the department's lead.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Department, Employee
from app.services.staffing import available_members, lead_of

ENGINEERING = "engineering"
QUALITY = "quality-assurance"

ARCHITECT_ROLES = ("Software Architect",)
AREA_ROLES: dict[str, tuple[str, ...]] = {
    "backend": ("Backend Developer", "AI Engineer", "Software Architect"),
    "frontend": ("Frontend Developer",),
    "setup": ("DevOps Engineer",),
    "docs": ("Software Architect",),
}


class NoTeam(Exception):
    """Nobody in Software Engineering can work right now."""


@dataclass
class Team:
    members: list[Employee]  # available engineers, most senior first
    lead: Employee  # the director (CTO), or the most senior engineer available
    reviewer: Employee  # Quality Assurance's lead when available, otherwise the lead
    _turn: dict[str, int] = field(default_factory=dict)

    def _with_role(self, roles: tuple[str, ...]) -> list[Employee]:
        for role in roles:
            people = [m for m in self.members if m.role.strip().lower() == role.lower()]
            if people:
                return sorted(people, key=lambda m: m.name)
        return []

    @property
    def architect(self) -> Employee:
        people = self._with_role(ARCHITECT_ROLES)
        return people[0] if people else self.lead

    def author(self, area: str) -> Employee:
        """The engineer for the next file of this area; people who share a role take turns."""
        people = self._with_role(AREA_ROLES.get(area, ()))
        if not people:
            return self.lead
        turn = self._turn.get(area, 0)
        self._turn[area] = turn + 1
        return people[turn % len(people)]


async def team(session: AsyncSession) -> Team:
    members = await available_members(session, ENGINEERING)
    department = await session.get(Department, ENGINEERING)
    lead = lead_of(department, members) if department else None
    if lead is None:
        raise NoTeam(
            "Nobody in Software Engineering is available (everyone is suspended or the "
            "department is empty), so the app can't be built."
        )
    quality = await session.get(Department, QUALITY)
    reviewer = lead_of(quality, await available_members(session, QUALITY)) if quality else None
    return Team(members=members, lead=lead, reviewer=reviewer or lead)
