"""Canned agent replies for workflow tests (unit and e2e) — no real model involved.

Each workflow prompt names its reply format ("Format: NEXUS-PLAN/1", …); this
answers with a valid reply built from what the prompt lists (departments, team).
"""

from __future__ import annotations

import json
import re

PREFERRED = ("research", "engineering")


def _departments(prompt: str) -> list[str]:
    return re.findall(r"^- ([a-z0-9-]+) — ", prompt, flags=re.MULTILINE)


def _team(prompt: str) -> list[str]:
    section = prompt.split("Your team", 1)[-1]
    return re.findall(r"^- (.+?) — ", section, flags=re.MULTILINE)


def canned_reply(prompt: str) -> str | None:
    if "Format: NEXUS-PLAN/1" in prompt:
        keys = _departments(prompt)
        chosen = [k for k in PREFERRED if k in keys] or keys[:2]
        assignments = [
            {
                "id": f"a{i + 1}",
                "department": key,
                "title": f"{key.replace('-', ' ').title()} deliverable",
                "instructions": f"Produce the {key} part of the objective as a short written deliverable.",
                "depends_on": [f"a{i}"] if i else [],
            }
            for i, key in enumerate(chosen)
        ]
        return json.dumps(
            {
                "summary": "Research the opportunity first, then plan the implementation.",
                "assignments": assignments,
                "deliverable": "A consolidated report with an implementation plan.",
            }
        )
    if "Format: NEXUS-BREAKDOWN/1" in prompt:
        names = _team(prompt)
        # The supervisor is listed first; give the work to two other people when possible.
        team = names[1:3] if len(names) >= 3 else names[:2]
        return json.dumps(
            {
                "approach": "Split the work between two specialists.",
                "tasks": [
                    {
                        "title": f"Part {i + 1} of the assignment",
                        "instructions": "Write your part of the department deliverable.",
                        "assignee": name,
                    }
                    for i, name in enumerate(team)
                ],
            }
        )
    if "Format: NEXUS-EMAIL/1" in prompt:
        return json.dumps(
            {
                "subject": "Following up on your message",
                "body": "Hello,\n\nThank you for getting in touch. [Confirm the details "
                "before sending.]\n\nBest regards,\n[Your name]",
            }
        )
    if "Format: NEXUS-REVIEW/1" in prompt:
        return json.dumps({"decision": "approve", "feedback": "Clear and usable."})
    if "Format: NEXUS-WORK/1" in prompt:
        return "## Deliverable\n\n- A concrete recommendation.\n- *Assumption:* market size needs verification."
    if "Format: NEXUS-SUMMARY/1" in prompt:
        return "## Department result\n\nCombined recommendation from the team (assumptions marked)."
    if "Format: NEXUS-REPORT/1" in prompt:
        return "## Summary\n\nThe company recommends a focused pilot.\n\n## Implementation plan\n\n1. Validate demand.\n2. Build an MVP."
    return None
