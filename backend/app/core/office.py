"""Rooms and desks of the headquarters, shared with the frontend layout."""

from __future__ import annotations

import json
from functools import lru_cache
from typing import TypedDict

from app.core.config import BACKEND_DIR

OFFICE_FILE = BACKEND_DIR.parent / "shared" / "office-desks.json"
NON_DEPARTMENT_ROOMS = {"lounge", "cafe", "data-center"}


class Desk(TypedDict):
    id: str
    room: str
    floor: str


class Room(TypedDict):
    id: str
    name: str
    floor: str


@lru_cache
def office() -> tuple[dict[str, Desk], dict[str, Room]]:
    data = json.loads(OFFICE_FILE.read_text(encoding="utf-8"))
    return {d["id"]: d for d in data["desks"]}, {r["id"]: r for r in data["rooms"]}


def desk_ids() -> set[str]:
    return set(office()[0])


def office_room_ids() -> set[str]:
    """Rooms a department can use as its office (not amenities/infrastructure)."""
    return set(office()[1]) - NON_DEPARTMENT_ROOMS
