# NEXUS AI — Stage Tracker

Rule: **one stage at a time.** After each stage the work is tested, inspected and
reported, and the next stage starts only after the owner's explicit approval.

| # | Stage | Status |
| --- | --- | --- |
| 1 | Repository, architecture & environment | ✅ Approved |
| 2 | High-quality 3D office world | ✅ Approved |
| 3 | AI employee characters | ✅ Complete, awaiting approval for Stage 4 |
| 4 | Departments & organisational structure | ⏳ Not started |
| 5 | NVIDIA AI connection | ⏳ Not started |
| 6 | Text communication | ⏳ Not started |
| 7 | Voice communication | ⏳ Not started |
| 8 | Multi-agent task orchestration | ⏳ Not started |
| 9 | Email integration | ⏳ Not started |
| 10 | Employee profiles & ratings | ⏳ Not started |
| 11 | Executive dashboard & project management | ⏳ Not started |
| 12 | Meetings & interdepartment collaboration | ⏳ Not started |
| 13 | Memory, documents & organisational knowledge | ⏳ Not started |
| 14 | Advanced office simulation | ⏳ Not started |
| 15 | Security, automation & reliability | ⏳ Not started |
| 16 | Final polish, testing & release preparation | ⏳ Not started |

---

## Stage 1 — Repository, architecture & environment

**Completed:** 2026-10-08 · **Commit:** "Stage 1: repository, architecture and environment"

### Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Backend starts | PASS | `make smoke`: `/api/health/live` 200 |
| Frontend starts | PASS | `make smoke`: `/` and `/healthz` 200 |
| Health checks pass | PASS | `/api/health/ready` 200, both directly and through the Next.js proxy |
| No secrets hardcoded | PASS | `test_repo_hygiene.py` (keys and emails); `.env` gitignored; build bundle scanned for the secret key and backend URL with 0 hits |
| Existing files preserved | PASS | `~/Desktop` was empty; the project lives in `~/Desktop/nexus-ai/` |

### Deliverables

- Working skeleton: FastAPI backend and Next.js frontend, joined by a same-origin proxy
- Technical architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md), [`adr/0001-tech-stack.md`](adr/0001-tech-stack.md)
- Development scripts: `Makefile`, `scripts/setup.sh`, `scripts/dev.sh`, `scripts/smoke.sh`
- Environment templates: `backend/.env.example`, `frontend/.env.example`
- Migration foundation: Alembic with migration `0001_initial`
- Structured logging with secret redaction, plus request IDs
- Initial automated tests: 24 backend, 8 frontend, and an 8-check smoke test
- Development docs: [`DEVELOPMENT.md`](DEVELOPMENT.md)

---

## Stage 2 — High-quality 3D office world

**Completed:** 2026-10-08 · **Commit:** "Stage 2: 3D office world"

### Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Office renders correctly | PASS | e2e "renders the office…" (no console errors); screenshots reviewed on the real GPU |
| Camera navigation works | PASS | e2e: keyboard zoom, rotate button, mouse drag pan; room focus framing unit-tested (`fit.test.ts`) |
| Rooms are identifiable | PASS | Labels for all visible rooms, department signs, accent outlines; e2e checks labels |
| Interactable areas work | PASS | e2e: label click, raycast floor click, room search, floor selector, 2D plan selection |
| Scene is responsive | PASS | e2e mobile (Pixel 7): no horizontal overflow, bottom-sheet panel |
| Performance is measured | PASS | `scripts/bench-3d.mjs` results in ARCHITECTURE.md §8 |

### Rooms delivered

- **Ground floor:** Reception, Sales, Marketing, Employee Lounge, Cafeteria
- **Level 2:** Executive Office, Meeting Room, Engineering
- 28 workstations with stable desk ids, ready for employee assignment in Stage 3

---

## Stage 3 — AI employee characters

**Completed:** 2026-10-08 · **Commit:** "Stage 3: AI employee characters"

### Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Multiple unique employees are visible | PASS | e2e: all 19 roster employees rendered, seated, unique ids; generator variety unit-tested |
| Animations function | PASS | Unit tests for poses (feet on floor, hands at keyboard, walk cycle); character studio e2e; walking verified by the suspend/activate e2e |
| Employee selection works | PASS | e2e: 3D click on a character (raycast) selects them; search and room team list select them |
| Employees have unique IDs | PASS | Backend `emp_` + 12 hex ids, unique desks (backend tests) |
| Visual states update from system state | PASS | e2e: suspend via API → avatar walks out and is marked away; activate → walks back and sits |

### Notes

- Only *idle* and *suspended* statuses occur until the task system exists (Stage 8);
  the other poses are wired and previewed in the character studio.
- Ambient breaks and idle motion are decorative, labelled, optional, and never change
  any status.
