"""Structured replies from agents (plans, breakdowns, reviews) and their validation.

Models reply with JSON; nothing they write is trusted until it passes these checks.
Rules that matter (which departments exist, who may be assigned, no dependency
cycles, hard size limits) are enforced here in code, never left to the prompt.
"""

from __future__ import annotations

import json
import re
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

MAX_ASSIGNMENTS = 4
MAX_TASKS_PER_ASSIGNMENT = 2


class PlanError(Exception):
    """A reply that can't be used (shown to the owner and fed back on retry)."""


def extract_json(text: str) -> dict[str, Any]:
    """The first JSON object in a reply (tolerates code fences and surrounding prose)."""
    cleaned = re.sub(r"```(?:json)?", "", text)
    decoder = json.JSONDecoder()
    for match in re.finditer(r"\{", cleaned):
        try:
            value, _ = decoder.raw_decode(cleaned[match.start() :])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise PlanError("The reply did not contain a JSON object.")


def _validated[T: BaseModel](model: type[T], data: dict[str, Any]) -> T:
    try:
        return model.model_validate(data)
    except ValidationError as error:
        first = error.errors()[0]
        where = ".".join(str(p) for p in first["loc"])
        raise PlanError(f"Invalid {where or 'reply'}: {first['msg']}.") from error


# ----------------------------------------------------------------------- plan


class PlanAssignment(BaseModel):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,12}$")
    department: str = Field(max_length=40)
    title: str = Field(min_length=3, max_length=120)
    instructions: str = Field(min_length=10, max_length=2000)
    depends_on: list[str] = Field(default_factory=list, max_length=MAX_ASSIGNMENTS)


class Plan(BaseModel):
    summary: str = Field(min_length=3, max_length=1500)
    assignments: list[PlanAssignment] = Field(min_length=1)
    deliverable: str = Field(default="", max_length=1000)


def parse_plan(text: str, available: dict[str, str]) -> Plan:
    """`available`: department key → name, for departments with someone to do the work."""
    plan = _validated(Plan, extract_json(text))
    if len(plan.assignments) > MAX_ASSIGNMENTS:
        raise PlanError(
            f"The plan has {len(plan.assignments)} assignments; the limit is {MAX_ASSIGNMENTS}."
        )
    ids = [a.id for a in plan.assignments]
    if len(set(ids)) != len(ids):
        raise PlanError("Assignment ids must be unique.")
    seen: set[str] = set()
    for a in plan.assignments:
        if a.department not in available:
            raise PlanError(
                f"Unknown or unavailable department '{a.department}'. Use only these keys: "
                + ", ".join(sorted(available))
                + "."
            )
        if a.department in seen:
            raise PlanError(
                f"Department '{a.department}' appears twice; give each department one assignment."
            )
        seen.add(a.department)
        for dep in a.depends_on:
            if dep == a.id:
                raise PlanError(f"Assignment {a.id} depends on itself.")
            if dep not in ids:
                raise PlanError(f"Assignment {a.id} depends on unknown assignment '{dep}'.")
    order = topological_order({a.id: a.depends_on for a in plan.assignments})
    if order is None:
        raise PlanError("The dependencies form a cycle.")
    return plan


def topological_order(graph: dict[str, list[str]]) -> list[str] | None:
    """Kahn's algorithm; None when there is a cycle."""
    remaining = {node: set(deps) for node, deps in graph.items()}
    order: list[str] = []
    while remaining:
        ready = sorted(n for n, deps in remaining.items() if not deps)
        if not ready:
            return None
        for node in ready:
            order.append(node)
            del remaining[node]
        for deps in remaining.values():
            deps.difference_update(ready)
    return order


# ------------------------------------------------------------------ breakdown


class BreakdownTask(BaseModel):
    title: str = Field(min_length=3, max_length=120)
    instructions: str = Field(min_length=10, max_length=2000)
    assignee: str = Field(min_length=1, max_length=120)


class Breakdown(BaseModel):
    approach: str = Field(default="", max_length=1000)
    tasks: list[BreakdownTask] = Field(min_length=1)


def parse_breakdown(text: str, team: dict[str, str]) -> tuple[Breakdown, list[str]]:
    """`team`: lower-cased name → employee id. Returns the breakdown and assignee ids."""
    breakdown = _validated(Breakdown, extract_json(text))
    if len(breakdown.tasks) > MAX_TASKS_PER_ASSIGNMENT:
        raise PlanError(
            f"{len(breakdown.tasks)} tasks were proposed; the limit is {MAX_TASKS_PER_ASSIGNMENT}."
        )
    assignees = []
    for task in breakdown.tasks:
        key = task.assignee.strip().lower()
        match = team.get(key) or next(
            (eid for name, eid in team.items() if key and (key in name or name in key)), None
        )
        if match is None:
            raise PlanError(
                f"'{task.assignee}' isn't on the team. Assign tasks only to: "
                + ", ".join(sorted(n.title() for n in team))
                + "."
            )
        assignees.append(match)
    return breakdown, assignees


# --------------------------------------------------------------------- review


class Review(BaseModel):
    decision: Literal["approve", "revise"]
    feedback: str = Field(default="", max_length=1500)


def parse_review(text: str) -> Review:
    data = extract_json(text)
    if isinstance(data.get("decision"), str):
        data["decision"] = data["decision"].strip().lower()
    return _validated(Review, data)
