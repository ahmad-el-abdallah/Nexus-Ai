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
| 9 | Email integration | ✅ Approved |
| 10 | Employee profiles & ratings | ✅ Complete, awaiting approval for Stage 11 |
| 11 | Executive dashboard & project management | ⏳ Not started |
| 12 | Meetings & interdepartment collaboration | ⏳ Not started |
| 13 | Memory, documents & organisational knowledge | ⏳ Not started |
| 14 | Advanced office simulation | ⏳ Not started |
| 15 | Security, automation & reliability | ⏳ Not started |
| 16 | Final polish, testing & release preparation | ⏳ Not started |

### Separate Data Center feature track

The Data Center & Digital Vault is tracked as **DC-1 through DC-8** in
[`DATA_CENTER.md`](DATA_CENTER.md). DC-2's visible 3D room and live read-only metadata
overview are complete and awaiting approval for DC-3. This feature track does not
change the global status above: Stage 10 remains complete and Stage 11 has not been
approved.

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

### Follow-up (owner request): English/Arabic only, gender-matched voices

- Agents write only in English or Arabic, in the owner's language; voice input is
  recognised as English or Arabic and transcribed as spoken, never translated.
- Every employee has a gender (migration 0009; seeded staff set from their original
  roster, editable, chosen when hiring). Female employees get female English voices and
  a raised Arabic voice (no female Arabic voice exists locally), use feminine Arabic
  forms, and look the part in the 3D office (no beards, matching hair).

### Follow-up (owner request): employees know their company

Directors said they had no access to their own team and the CEO knew nothing about other
departments: agents only had their own name, role and department description. Every AI
call now includes a live briefing from the records, scoped by position (staff: team +
directory; directors: + team workload and track record; executives: the whole company,
workflows and the email queue). Verified with the real model: the Sales director listed
his five team members and their current work; the CEO answered in Arabic with all 20
departments, Marketing's headcount and Finance's director.

### Follow-up (owner request): face-to-face voice sessions

No 3-second countdown (sent as soon as the owner stops talking, 0.8 s of silence),
replies spoken sentence by sentence while they are written, short spoken-style answers
without tables or lists, a single-pass English/Arabic transcription, and the employee's
3D face on screen with the mouth moving to the voice, blinking and nodding. A ⛶ button shows the employee full screen.

### Follow-up (owner request): faster replies

Replies spent 80–90 % of their tokens on hidden reasoning (4–13 s per answer). Chat and
voice now ask the model to answer directly: first words in ~1 s (was ~8 s for the same
question), 0 reasoning tokens. A setting turns thinking back on; workflows and email
drafts keep it.

### Follow-up (owner request): tasks are actually done

Creating a task used to only record it. Now the assignee (or the director) starts at
once, works on it visibly in the office, and posts the result in the chat it came from;
the task board shows running / done (with the result) / failed (Run again) and can
cancel. Real run: Sameer Abuhummus delivered a full design for an API error-rate
monitoring tool in 18 s.

### Follow-up (owner request): run employee code safely

▶ Run on Python / JavaScript / Bash code blocks in replies and task results: the owner
approves the exact code, then it runs in a bubblewrap sandbox (no internet, no access
to the owner's files, 30 s / 512 MB / 64 processes) and the output, exit code and
created files appear in the dialog. Real run: Sameer Abuhummus wrote a 91-line error-
rate script for a task (13 s); approved, it ran in 49 ms and produced error_report.csv.

### Follow-up (owner request): English-only replies, and build real tools

Agents now always reply in English even when the owner writes in Arabic (voice input is
still transcribed in the spoken language, never translated — only the agent's reply is
English). The Arabic grammatical-gender prompt lines were dropped; the gender-matched
voice stays. Engineering, IT, Data, QA and Security employees are told they are the
owner's own engineer and must build complete, real, runnable tools for the owner's own
systems — including networking, security and system-administration tools such as a
network or port scanner — instead of refusing or giving only an outline, declining only
requests framed as intruding on systems the owner has no right to.

### Follow-up (owner request): engineering builds, stores and runs full web apps

**Completed:** 2026-10-09 · **Commit:** "Engineering builds, stores and runs full web apps"

The owner asks for a web application (Apps page, or **Build as app** on a chat message).
The Software Architect designs it; the owner approves; each file is written by the
engineer whose role fits it (backend → Backend Developer, frontend → Frontend Developer,
setup files → DevOps Engineer, docs → Software Architect — decided in code); the result
is syntax-checked, reviewed by Quality Assurance and fixed once; the CTO writes the
delivery note. The app is stored with its versions, can be downloaded as a zip, run in
the sandbox without downloading, and changed with a change request (a new version that
rewrites only the affected files). Design: `ARCHITECTURE.md` → "Apps".

| Criterion | Result | Evidence |
| --- | --- | --- |
| Work is split by role | PASS | Backend/e2e tests: files go to the matching roles, with fallbacks when a role is unavailable; real run below |
| Nothing is written before approval | PASS | Tests: only the design request runs; 4 concurrent approvals count once |
| Full app is stored and downloadable | PASS | Files and versions in the database; zip download checked in backend and browser tests |
| Runs without downloading, only after approval | PASS | Tests + real run: the version's hash must match; the app answers through the preview port; a wrong hash is refused |
| A running app is isolated | PASS | Test from inside the app: no network, empty environment, own folder only; the install proxy refuses every host except the three registries (incl. NEXUS's own API) |
| Packages can be installed | PASS | Opt-in test with the real registries: Flask (PyPI), Express (npm) and a React/Vite build all install, start and answer |
| Change requests | PASS | Tests + real run: version 2 rewrites only the planned files, version 1 stays available |
| No endless loops, failures visible | PASS | Request cap, one fix round, pause/resume, cancel, restart recovery; unfixed problems are listed, an unusable review is reported as missing |

**Real run** (owner's key, `nvidia/nemotron-3-super-120b-a12b`, on a copy of the
database): "a to-do list for my team…" → design in 8 s (1 request): Flask + SQLite,
6 files. Build in 117 s (10 requests in total): Yusuf Demir wrote `server.py`, Amara
Mensah the three frontend files, Kenji Watanabe `requirements.txt`, Felix Schmidt the
README; the QA Director's review found a real defect (static files served under a
doubled path) and the backend developer fixed it. Approved to run: Flask was installed
from PyPI in the sandbox in 3 s and the app answered. Checked by hand through the
preview port: adding, listing, filtering by owner, marking done and deleting tasks work,
and the tasks were still there after a restart. A change request ("show a counter of
open tasks") produced version 2 in 89 s (6 requests), rewriting two files. **16 model
requests in total.**

Limits to know: a running app has no internet access; apps are text files only (≤ 16
files); quality depends on the model, so an app may need a change request before it
works — the run log and "Ask the team to fix this" are there for that; the preview opens
only on the computer NEXUS runs on. Also fixed: a test that depended on directory
listing order, and one unformatted test file.

## Stage 10 — Employee profiles & ratings

**Completed:** 2026-10-09 · **Commit:** "Stage 10: employee profiles & ratings"

A profile opens from any 3D character (View profile) or from an employee name in a
department table, at `/employees/{id}`. It shows identity, office, manager and team;
owner-managed **skills**; **active assignments** and **task history**; an **evidence-based
performance** panel; the owner's **ratings and feedback** with history; and a **change
history** (hiring, role/department/seniority/desk/model changes, suspensions, ratings).

Performance is computed live (`app/services/profiles.py`) from recorded tasks, sandbox
runs and supervisor revisions — never stored, never invented. With no finished work it
shows "Not enough data". Skills, ratings and notes are the only things the owner stores;
every structural change is logged to `employee_events` (migration `0012_profiles`).

### Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Profiles open from the 3D characters | PASS | EmployeePanel "View profile" → `/employees/{id}`; also from department team tables; e2e |
| Task stats are accurate | PASS | Counts come straight from the `tasks`/`code_runs` rows for that assignee; unit test with seeded done/failed/running tasks and runs → 60 % from 3 of 5 |
| Ratings come from evidence | PASS | Performance is computed from real tasks/runs; the owner's star rating is a separate average of stored feedback, never blended into a fake number |
| Unknown metrics show insufficient data | PASS | No finished work → "Not enough data"; no skills/ratings/history → explicit empty states (screenshot) |
| Modifications persist | PASS | Skills and feedback saved via the API, survive reload; e2e checks the API reflects them |

