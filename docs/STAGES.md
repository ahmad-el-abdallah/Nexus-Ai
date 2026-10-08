# NEXUS AI — Stage Tracker

Rule: **one stage at a time.** After each stage the work is tested, inspected and
reported, and the next stage starts only after the owner's explicit approval.

| # | Stage | Status |
| --- | --- | --- |
| 1 | Repository, architecture & environment | ✅ Approved |
| 2 | High-quality 3D office world | ✅ Approved |
| 3 | AI employee characters | ✅ Approved |
| 4 | Departments & organisational structure | ✅ Approved |
| 5 | NVIDIA AI connection | ✅ Approved |
| 6 | Text communication | ✅ Approved |
| 7 | Voice communication | ✅ Approved |
| 8 | Multi-agent task orchestration | ✅ Approved |
| 9 | Email integration | ✅ Complete, awaiting approval for Stage 10 |
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

---

## Stage 4 — Departments & organisational structure

**Completed:** 2026-10-08 · **Commit:** "Stage 4: departments and organisational structure"

### Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Departments exist | PASS | All 20 seeded in order with roles, responsibilities, directors (backend test, e2e directory) |
| Every agent has a valid role | PASS | Backend test over the whole roster; create/edit reject roles outside the department (422) |
| Agents can be assigned to departments | PASS | Backend + e2e: move Noah Fischer to Research with a valid role |
| Organisation hierarchy works | PASS | Single tree under the CEO after hire / move / remove / new director / new CEO (backend tests); org chart e2e |
| Changes persist | PASS | Department configuration survives reload (e2e); all edits verified via fresh API reads (backend tests) |
| No 20 simultaneous model sessions | PASS (by design) | No agent runtime exists yet; agents are database records only |

---

## Stage 5 — NVIDIA AI connection

**Completed:** 2026-10-08 · **Commit:** "Stage 5: NVIDIA AI connection"

### Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Real NVIDIA inference works with valid credentials | PASS | Owner's key: 80 models listed; 4 verified; connection test ok; streamed reply as Iris Wong via the Next.js proxy |
| Invalid keys produce clear errors | PASS | "NVIDIA rejected the API key…" (backend test + e2e with a wrong saved key) |
| Tokens are protected | PASS | Key never returned (only last 4), encrypted at rest when saved in-app, redacted from logs, absent from builds and tracked files |
| Model configuration can change | PASS | Default / department / employee routing (backend tests + e2e) |
| Usage and failures are tracked | PASS | `ai_usage` per attempt incl. rejected, retried, cancelled; usage dashboard (tests + e2e) |
| No paid fallback | PASS | Gateway has a single provider; tests assert no other host is contacted |

### Real-account findings (owner's key)

- 80 models listed. Verified as working: `nvidia/nemotron-3-super-120b-a12b` (0.8 s),
  `nvidia/nemotron-3.5-lightning-30b-a3b` (2.0 s), `openai/gpt-oss-20b` (2.4 s), `z-ai/glm-5.3-flash` (29 s).
- Not available to this account (404): `nvidia/nemotron-nano-3-30b-a3b`, `mistralai/mistral-large-2-instruct`
  (and 3 others probed earlier).
- Several of these are reasoning models that spend output tokens on hidden reasoning; the UI
  explains empty replies instead of failing silently.

---

## Stage 6 — Text communication

**Completed:** 2026-10-08 · **Commit:** "Stage 6: text communication"

### Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Owner can message Marketing | PASS | e2e: "Message Marketing" → Elena Rossi (director) replies, streamed and saved; real NVIDIA reply too |
| Owner can message Engineering | PASS | e2e: Software Engineering → Iris Wong; real NVIDIA reply |
| Owner can message the CEO | PASS | e2e: "Message the CEO" → Aria Vance; real NVIDIA reply |
| Correct agents respond | PASS | Backend routing tests (director, most-senior fallback, suspended, nobody available); usage rows carry the right department |
| Conversations persist | PASS | Stored in SQLite; e2e reload; restart recovery test |
| Messages are not routed to the wrong department | PASS | Parametrised test over Marketing / Engineering / Sales; responder must be a department member (checked in code) |

### Deliverables

- Chat page (`/chat`): conversation list with search, CEO/department/people picker,
  Markdown messages with author, timestamps, model and real token/latency figures,
  streaming with honest progress (waiting for a slot / request sent / thinking / writing),
  stop, try again, rename, delete, attachments (text read by the model, others labelled)
- Background replies through the AI gateway; context window of the newest messages
- Live updates over Server-Sent Events (`/api/events`) replacing the 5 s roster poll
  (polling only while disconnected); employees show **Working — Replying in chat** and
  type at their desks in the 3D office while replying
- Tasks recorded from any message, shown on the department task board as
  "open — not started" (execution is Stage 8); cancel / reopen
- "Message" shortcuts on the employee panel, room panel and department pages
- Migration `0005_chat`

### Real-account check (owner's key, on a copy of the dev database)

Three real requests on `nvidia/nemotron-3-super-120b-a12b`: Marketing → Elena Rossi
(first token 898 ms, 3.2 s total), Software Engineering → Iris Wong (860 ms, 1.6 s),
CEO → Aria Vance (698 ms, 2.8 s). Each reply introduced the right person and department.

---

## Stage 7 — Voice communication

**Completed:** 2026-10-08 · **Commit:** "Stage 7: voice communication"

### Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Voice input transcribes | PASS | Real: Chrome mic fed a recorded sentence → Whisper base, 6.5 s of audio in ~1.2 s (English and Arabic); e2e with stand-in engines |
| Transcript reaches the correct employee | PASS | Voice message to Marketing answered by Elena Rossi (real NVIDIA); backend + e2e tests; same routing code as text |
| Agent responds | PASS | Real replies from Elena Rossi (English and Arabic) and Iris Wong (hands-free session) |
| Speech output works when configured | PASS | Real Piper speech for replies (English voice per employee, Arabic voice); e2e checks the WAV responses |
| Text remains a working fallback | PASS | e2e: with the microphone blocked, typing and sending still work |
| Missing microphone permission doesn't crash | PASS | e2e (NotAllowedError) + unit tests for every getUserMedia failure; no page errors |

### Deliverables

- Local speech: faster-whisper (Whisper base/small) and Piper (English with 904 voices,
  Arabic), installed from Settings → Voice. Each model is pinned to a revision and
  verified by SHA-256. A real install of base + both voices (~290 MB) took 24 s.
- Chat: mic button → transcript for review → sent as a voice message with the
  recording attached and playable. "Listen" on replies. Voice sessions read replies
  aloud and, hands-free, listen again and auto-send after a cancellable 3-second
  countdown. Mic mute, voice mute, end session. Arabic and English with right-to-left
  display.
- Settings → Voice: install or remove models with progress, recognition model choice,
  language (auto/English/Arabic), read replies aloud, mute all, speaking speed,
  microphone test with timings, voice previews per employee.
- System status shows the local voice state. Migration `0006_voice`.
- `./start.sh` runs the backend and frontend together in one terminal.

### Measured on this computer (CPU only)

| Step | Time |
| --- | --- |
| Whisper base, 2.8–6.8 s clip | 1.0–2.4 s |
| Whisper small, same clips | 4.0–8.5 s |
| Piper, per second of speech | ~0.1–0.15 s |
| First spoken part of a reply (UI) | 1.1 s (English), 2.6 s (Arabic) |

---

## Stage 8 — Multi-agent task orchestration

**Completed:** 2026-10-08 · **Commit:** "Stage 8: multi-agent orchestration"

### Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| CEO delegates work | PASS | Real NVIDIA runs: Aria Vance planned and delegated to 3 departments each time; backend + e2e tests |
| Multiple agents execute relevant subtasks | PASS | Real run 2: Marcus Bell → Diego Alvarez (Sales), Iris Wong → Felix Schmidt (Engineering), Elena Rossi (Marketing); supervisor reviews approved the work |
| Results are consolidated | PASS | The CEO's final report covers every department; posted on the workflow and in the source chat |
| Failed tasks are reported | PASS | Tests: failed task → department failed → dependents skipped → report lists what did not complete ("completed with failures"); timeline shows each failure |
| Workflow can be cancelled | PASS | Tests + e2e: in-flight steps stopped and awaited, every open task cancelled, no further requests |
| No infinite agent loops | PASS | Hard limits in code (≤ 4 departments, ≤ 2 tasks, ≤ 1 revision, ≤ 2 attempts, request cap, 45 min); tests force repeated "revise" and the request cap |

### Real-account demonstrations (copy of the dev database)

| Objective | Plan | Requests | Time |
| --- | --- | --- | --- |
| "Research a new software business opportunity and create an implementation plan." (the spec's example) | Market Research → Product → Finance (chained hand-offs) | 5 | 87 s |
| "Plan the launch of our new AI meeting-notes app…" | Marketing, Sales, Engineering in parallel; supervisors assigned workers and reviewed | 10 | 116 s |

Both used `nvidia/nemotron-3-super-120b-a12b`; departments whose only member is the
supervisor do the work directly (no self-review).

### Follow-up (owner request): desk monitors show real work

Monitors in the 3D office now show each employee's actual current work in a role-styled
app (code editor for engineers, documents for marketing, CRM for sales, spreadsheet for
finance, …): the task or message they handle and the text they produce, streamed live.
"View screen" looks over their shoulder. Nothing is invented — idle desks say so.

## Stage 9 — Email integration

**Completed:** 2026-10-08 · **Commit:** "Stage 9: email integration"

Settings → Email accounts connects how the company sends: **Brevo** (the owner's choice,
recommended: API key + a sender verified in Brevo) or a mailbox directly (Gmail,
Microsoft 365, Yahoo, iCloud, Zoho, custom SMTP/IMAP; app password or OAuth with the
owner's own app registration). The **Email** page has the approval queue, inbox, outbox,
sent, rejected and the email log. Design: [`adr/0002-email-sending.md`](adr/0002-email-sending.md).

### Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Configured account connects | PASS (local fake servers) · NOT TESTED with a real provider | Connection tests pass against the fake SMTP/IMAP server and fake Brevo API (backend + e2e). A real Brevo/Gmail account needs the owner's credentials |
| Drafts can be generated | PASS | Owner-written and AI-written drafts; real NVIDIA run (Nemotron 3 Super, 1 request, 6 s) drafted a reply to an email containing a prompt injection and ignored it |
| Owner approval is required | PASS | Only `pending_approval → approved` queues a send (atomic); edits withdraw approval; tests check nothing is sent before approval and 4 concurrent approvals send once |
| Approved messages can be sent | PASS | Fake SMTP and fake Brevo receive exactly one message with the fixed Message-ID / idempotencyKey |
| Provider failures are visible | PASS | Login, unverified sender, rejection, rate limit, temporary failure, dropped connection, IMAP down: shown on the message, the account and in the log |
| No duplicate emails during retry | PASS | Auto-retry only when the server definitely didn't accept the message (≤ 2); a broken connection mid-send is "uncertain" and never resent without explicit confirmation |
| No secret leaks | PASS | Passwords, API keys, OAuth tokens and client secrets are encrypted and never returned or logged (tests); client bundle and repo scanned for secret values |

