"""Structured replies in an app build (design, change plan, review, file content) and
their validation.

Models reply with JSON or with one file; nothing they write is trusted until it passes
these checks. Where files may go, which stacks exist, how many files an app may have and
which files a change may touch are enforced here in code, never left to the prompt.
"""

from __future__ import annotations

import json
import re
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from app.apps.stacks import MAX_FILE_CHARS, MAX_FILES, STACKS, Stack, clean_path
from app.orchestration.plans import PlanError, _validated, extract_json
from app.orchestration.prompts import clean_text

MAX_ISSUES = 8
_PACKAGE = re.compile(r"^[A-Za-z0-9@/._-]{1,60}$")


def _packages(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    names = [str(v).strip() for v in value if isinstance(v, str | int)]
    return [n for n in names if _PACKAGE.match(n)][:20]


def _text(value: Any) -> Any:
    """Models sometimes give a list or an object where text was asked for."""
    if isinstance(value, list | dict):
        return json.dumps(value, indent=1)
    return value


# --------------------------------------------------------------------- design


class DesignFile(BaseModel):
    path: str = Field(min_length=1, max_length=200)
    purpose: str = Field(min_length=3, max_length=400)


class Design(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    summary: str = Field(min_length=10, max_length=1500)
    stack: str = Field(max_length=24)
    api: str = Field(default="", max_length=4000)
    packages: list[str] = Field(default_factory=list)
    files: list[DesignFile] = Field(min_length=1)

    api_as_text = field_validator("api", mode="before")(_text)
    package_names = field_validator("packages", mode="before")(_packages)


def _checked_path(path: str) -> str:
    try:
        return clean_path(path)
    except ValueError as error:
        raise PlanError(f"File path: {error}.") from error


def parse_design(text: str) -> Design:
    design = _validated(Design, extract_json(text))
    design.stack = design.stack.strip().lower()
    stack = STACKS.get(design.stack)
    if stack is None:
        raise PlanError(
            f"Unknown stack '{design.stack}'. Use one of: " + ", ".join(sorted(STACKS)) + "."
        )
    seen: set[str] = set()
    for file in design.files:
        file.path = _checked_path(file.path)
        if file.path.lower() in seen:
            raise PlanError(f"'{file.path}' is listed twice.")
        seen.add(file.path.lower())
    missing = [p for p in stack.required if p.lower() not in seen]
    if missing:
        raise PlanError(
            f"The '{stack.key}' stack needs these files, which are missing from the list: "
            + ", ".join(missing)
            + "."
        )
    # Always present, whatever the model listed: how to use the app, and — when packages
    # are used — the file that declares them.
    if design.packages and stack.key.startswith("python") and "requirements.txt" not in seen:
        design.files.append(
            DesignFile(path="requirements.txt", purpose="The Python packages the backend uses.")
        )
    if "readme.md" not in seen:
        design.files.append(
            DesignFile(path="README.md", purpose="What the app does and how to use it.")
        )
    if len(design.files) > MAX_FILES:
        raise PlanError(
            f"The design has {len(design.files)} files; the limit is {MAX_FILES}. "
            "Merge small files."
        )
    return design


# --------------------------------------------------------------------- change


class ChangeFile(BaseModel):
    path: str = Field(min_length=1, max_length=200)
    action: Literal["modify", "add", "delete"]
    instructions: str = Field(default="", max_length=1500)
    purpose: str = Field(default="", max_length=400)

    @field_validator("action", mode="before")
    @classmethod
    def _lower(cls, value: Any) -> Any:
        return value.strip().lower() if isinstance(value, str) else value


class Change(BaseModel):
    summary: str = Field(min_length=5, max_length=1500)
    files: list[ChangeFile] = Field(min_length=1)
    packages: list[str] = Field(default_factory=list)

    package_names = field_validator("packages", mode="before")(_packages)


def parse_change(text: str, stack: Stack, existing: set[str]) -> Change:
    """`existing`: the paths of the version being changed."""
    change = _validated(Change, extract_json(text))
    lower = {p.lower(): p for p in existing}
    seen: set[str] = set()
    for file in change.files:
        file.path = _checked_path(file.path)
        key = file.path.lower()
        if key in seen:
            raise PlanError(f"'{file.path}' is listed twice.")
        seen.add(key)
        if file.action == "add":
            if key in lower:
                raise PlanError(f"'{file.path}' already exists; use the action 'modify'.")
            file.purpose = file.purpose.strip() or file.instructions.strip()
            if len(file.purpose) < 3:
                raise PlanError(f"Say what the new file '{file.path}' is for.")
        else:
            if key not in lower:
                raise PlanError(
                    f"'{file.path}' isn't a file of this app. Existing files: "
                    + ", ".join(sorted(existing))
                    + "."
                )
            file.path = lower[key]
            if file.action == "delete" and file.path in stack.required:
                raise PlanError(f"'{file.path}' is required by the stack and can't be deleted.")
        if file.action != "delete" and len(file.instructions.strip()) < 3:
            raise PlanError(f"Say what to do in '{file.path}'.")
    added = sum(f.action == "add" for f in change.files)
    deleted = sum(f.action == "delete" for f in change.files)
    if len(existing) + added - deleted > MAX_FILES:
        raise PlanError(f"The app would have more than {MAX_FILES} files; merge small files.")
    return change


# --------------------------------------------------------------------- review


class Issue(BaseModel):
    path: str = Field(min_length=1, max_length=200)
    problem: str = Field(min_length=5, max_length=600)


class AppReview(BaseModel):
    decision: Literal["approve", "revise"]
    issues: list[Issue] = Field(default_factory=list)

    @field_validator("decision", mode="before")
    @classmethod
    def _lower(cls, value: Any) -> Any:
        return value.strip().lower() if isinstance(value, str) else value


def parse_review(text: str, paths: set[str]) -> AppReview:
    review = _validated(AppReview, extract_json(text))
    lower = {p.lower(): p for p in paths}
    for issue in review.issues:
        key = issue.path.strip().replace("\\", "/").removeprefix("./").lower()
        if key not in lower:
            raise PlanError(
                f"'{issue.path}' isn't a file of this app. Use only: "
                + ", ".join(sorted(paths))
                + "."
            )
        issue.path = lower[key]
    if review.decision == "revise" and not review.issues:
        raise PlanError("A 'revise' decision must list the file and the problem to fix.")
    if len(review.issues) > MAX_ISSUES:
        review.issues = review.issues[:MAX_ISSUES]
    return review


# ----------------------------------------------------------------------- file

_BLOCK = re.compile(r"^```[^\n]*\n(.*?)^```[ \t]*$", re.DOTALL | re.MULTILINE)
CUT_OFF = (
    "The reply was cut off before the file ended. Write the complete file again, more "
    "compactly, so that it fits in one reply."
)


def extract_file(text: str, path: str, finish_reason: str | None = None) -> str:
    """The file's content from a reply: what is inside its code block (or the whole
    reply when there is none). A reply that stops mid-file is refused."""
    cleaned = clean_text(text)
    lines = cleaned.splitlines()
    if lines and lines[0].lstrip().startswith("```"):
        # Wrapped in one block. Its last line closes it, so blocks nested inside (as in a
        # README) stay part of the content.
        last = lines[-1].rstrip()
        if len(lines) < 2 or not last.endswith("```"):
            raise PlanError(CUT_OFF)
        # The closing fence usually has its own line; sometimes it ends the last one.
        content = "\n".join([*lines[1:-1], last[:-3]])
    else:
        if finish_reason == "length":
            raise PlanError(CUT_OFF)
        blocks = [] if path.lower().endswith(".md") else _BLOCK.findall(cleaned)
        content = max(blocks, key=len) if blocks else cleaned
    content = content.strip("\n")
    if not content.strip():
        raise PlanError("The reply contained no file content.")
    if len(content) > MAX_FILE_CHARS:
        raise PlanError(
            f"The file is {len(content)} characters long; the limit is {MAX_FILE_CHARS}. "
            "Write it more compactly."
        )
    return content + "\n"
