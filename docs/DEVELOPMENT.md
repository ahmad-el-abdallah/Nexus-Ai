# Development Guide

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 20.9+ (22 LTS recommended) | Includes npm |
| uv | 0.5+ | Manages Python 3.12 and backend dependencies |
| make, bash, curl | any | Used by scripts |
| Google Chrome / Chromium | optional | Visual checks and WebGL testing |

No Docker, cloud account or paid service is needed.

## First run

```bash
make setup
make dev
```

`make setup` is idempotent. It:
1. checks prerequisites
2. installs locked dependencies (`uv sync --frozen`, `npm ci`)
3. creates `backend/.env` and `frontend/.env` from their `.env.example` templates
4. generates a random `NEXUS_SECRET_KEY` into `backend/.env` (mode `600`)
5. applies database migrations

`make dev` serves:
- frontend: http://localhost:3000
- backend: http://127.0.0.1:8000, reached from the frontend via the `/api/*` proxy
- API docs: http://localhost:3000/api/docs

Ctrl-C stops both.

### Windows

`start.bat` runs NEXUS inside **WSL2** (Linux on Windows). Running natively is not
possible where Windows Smart App Control is on: it blocks the unsigned compiled Python
packages the backend needs ("An Application Control policy has blocked this file").

- **First time:** `start.bat` offers to install WSL2 with Ubuntu (administrator rights,
  then restart Windows and open "Ubuntu" once to create the Linux user). After that,
  `scripts/wsl-start.sh` installs Node.js 22 (checksum-verified, into
  `~/.local/share/nexus-ai-wsl/node`) and uv (`~/.local/bin`) inside Linux — no
  administrator rights — and `./start.sh` installs the project's dependencies.
- **Every start** copies the Windows folder to a run copy at `~/nexus-ai` in Linux:
  tracked files plus new files that aren't ignored, uncommitted changes included, with
  Linux line endings. The Windows repository is only read. Edit code in the Windows
  folder and restart `start.bat` to run it.
- **Data lives in the run copy**, never in the Windows folder: `backend/.env` (the
  secret key and, if you use it, `NVIDIA_API_KEY`), `backend/var/` (database, voice
  models, sandbox runs) and installed dependencies. From Windows it is at
  `\\wsl.localhost\Ubuntu\home\<linux user>\nexus-ai`. Back up `backend/.env` from there.
- **▶ Run** on employee code needs `sudo apt install -y bubblewrap` in Ubuntu.
- **`start.bat --lan`** needs WSL mirrored networking (`networkingMode=mirrored` under
  `[wsl2]` in `%USERPROFILE%\.wslconfig`, then `wsl --shutdown`); with the default
  networking only this PC can open NEXUS.
- `make` targets and tests run in Ubuntu. To test without touching the copy the servers
  run from, make a second copy first, from the Windows folder:
  `wsl -e bash -c "NEXUS_WSL_DIR=~/nexus-ai-dev bash <(tr -d '\r' < scripts/wsl-start.sh) --sync-only"`,
  then run the commands in `~/nexus-ai-dev` (`uv` is in `~/.local/bin`, Node.js in
  `~/.local/share/nexus-ai-wsl/node/bin`).

### Opening NEXUS from other devices (LAN)

`./start.sh --lan` (or `NEXUS_LAN=1 make dev`) binds the frontend to `0.0.0.0` and
prints `http://<this machine's IP>:3000` for phones and other computers on the same
network. The backend stays on `127.0.0.1`; other devices reach it through the `/api/*`
proxy. Notes:
- There is no login: anyone on the network can use NEXUS (and its AI budget). Use it on a
  network you trust only.
- The microphone needs a secure page, so voice only works at `http://localhost:3000`.
- If another device can't connect, allow the port in the firewall:
  `sudo ufw allow from 192.168.0.0/16 to any port 3000 proto tcp`.

## Commands

| Command | Purpose |
| --- | --- |
| `make dev` | Backend and frontend with live reload |
| `make test` | `pytest` (backend) and `vitest` (frontend) |
| `make lint` | `ruff check`, `ruff format --check`, `eslint`, `tsc --noEmit` |
| `make format` | Auto-fix and format backend code |
| `make build` | Next.js production build |
| `make test-e2e` | Playwright browser tests against a production build, using your installed Chrome on the real GPU (`E2E_SOFTWARE_GL=1` forces software rendering) |
| `make bench URL=…` | Orbit the 3D office for 10 s per quality level and print frame-time statistics |
| `make smoke` | Starts both servers on a throwaway DB, checks every health endpoint directly and via the proxy, then confirms the proxy reports failure once the backend stops |
| `make check` | lint, test, build and smoke |
| `make migrate` | Apply migrations |
| `make migration name="..."` | Autogenerate a migration from model changes |
| `make clean` | Remove build caches (keeps `.env` and the database) |

`make smoke` needs ports 8000 and 3000 free, or set
`SMOKE_API_PORT=18000 SMOKE_WEB_PORT=13000`. `next dev` allows only one instance per
project directory, so stop `make dev` first.

## Configuration

### Backend (`backend/.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXUS_ENV` | `development` | `development` / `test` / `production` |
| `NEXUS_HOST` / `NEXUS_PORT` | `127.0.0.1` / `8000` | Bind address |
| `NEXUS_LOG_LEVEL` | `INFO` | Log level |
| `NEXUS_LOG_FORMAT` | `console` | `console` or `json` |
| `NEXUS_CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Comma-separated allowlist |
| `NEXUS_DATABASE_URL` | SQLite at `backend/var/nexus.db` | e.g. `postgresql+asyncpg://user@localhost:5432/nexus_ai` |
| `NEXUS_SECRET_KEY` | generated by setup | Master key for encrypting stored credentials (the NVIDIA key saved in the app, email passwords and OAuth tokens). **Back it up.** Losing it makes stored credentials unreadable |
| `NEXUS_PUBLIC_URL` | `http://localhost:3000` | Where you open NEXUS in the browser. Email OAuth sign-ins return to `<this>/api/email/oauth/callback`; register that exact URI with Google/Microsoft |
| `NEXUS_RUNS_DIR` | `backend/var/runs` | Sandbox runs: work folders and files the code wrote. The sandbox needs `bwrap` (bubblewrap) and `systemd-run --user` |
| `NEXUS_APPS_DIR` | `backend/var/apps` | Apps built by engineering: each app's files, installed packages and stored data when it runs |
| `NEXUS_PREVIEW_PORT` | `8100` | Where a running app is reached (`http://localhost:8100`), bound to `127.0.0.1` |
| `NEXUS_BREVO_API_URL` | `https://api.brevo.com/v3` | Brevo's API (tests point it at the fake in `tests/fake_mail.py`) |
| `NVIDIA_API_KEY` | empty | NVIDIA API key, read server-side only. A key saved in Settings → AI providers (encrypted) takes precedence |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | Initial base URL; editable in Settings (https only, or http for localhost) |

Shell environment variables override `.env` values.

#### Data Center storage (DC-3 operational backend)

These server-side settings are implemented and validated. `GET /api/storage/overview`
returns safe aggregate metadata for the 3D Data Center panel without exposing file
names, storage keys or server paths. Owner-facing routes under `/api/storage` now list
workspaces and entries, create folders, stream uploads and downloads, rename/move items,
move trees to Trash, restore them and run non-destructive reconciliation. The browser
explorer is not connected until DC-5. Implementation and test evidence are tracked in
[`DATA_CENTER.md`](DATA_CENTER.md).

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXUS_STORAGE_BACKEND` | `local` | Blob backend; DC-1 supports local storage only |
| `NEXUS_STORAGE_ROOT` | `backend/var/storage` | Private root for committed and temporary blobs |
| `NEXUS_STORAGE_MAX_FILE_BYTES` | `104857600` | Maximum bytes in one file (100 MiB) |
| `NEXUS_STORAGE_DEPARTMENT_QUOTA_BYTES` | `10737418240` | Default logical department quota (10 GiB) |
| `NEXUS_STORAGE_ALLOWED_EXTENSIONS` | Initial documented file-type allowlist | Comma-separated extensions accepted by storage policy |
| `NEXUS_STORAGE_BACKUP_ROOT` | unset | Optional future local backup destination; unset means not configured |

On Windows, the default root is inside the selected WSL run copy's `backend/var/` and
is not copied back into the Windows Git checkout. Development tests must override it
with a temporary path in `~/nexus-ai-dev`; they must never point at the owner's running
`~/nexus-ai` data. A backup on the same physical drive is not disaster recovery.

The API accepts logical names and opaque IDs only. Uploaded extensions must be in the
configured allowlist. Size and workspace quota limits are enforced while streaming;
Trash does not free quota or delete immutable blobs. `POST /api/storage/maintenance/reconcile`
checks every recorded SHA-256/size, marks missing or corrupt versions unavailable and
reports orphaned/unsafe objects without deleting them.

### Frontend (`frontend/.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXUS_BACKEND_URL` | `http://127.0.0.1:8000` | Proxy target for `/api/*`. `next dev` reads it at startup; **production builds fix it at build time**, so rebuild after changing it |

Never put secrets in `NEXT_PUBLIC_*` variables, because those are compiled into
browser JavaScript.

## Project layout

```
backend/   FastAPI app (app/), Alembic migrations (migrations/), tests (tests/)
frontend/  Next.js app (src/app, src/components, src/lib, src/hooks)
scripts/   setup.sh, dev.sh, smoke.sh
docs/      architecture, development, stages, ADRs, design references
```

## 3D headquarters

- **Edit the building** in `frontend/src/world/layout/building.ts`. Then run
  `npm run test` in `frontend`. The layout tests check:
  - rooms tile each floor without overlapping
  - furniture stays inside its room and doesn't collide
  - every doorway has a clear metre on both sides
  - wall items fit their walls
  - each geometry fits its declared footprint
- **URL options:**
  - `?view=2d` opens the 2D plan
  - `?quality=low|balanced|high` sets render quality
  - `?perf` shows renderer statistics
  - `?bench=1` orbits continuously and publishes `window.__NEXUS_BENCH__`
  - `?nowebgl` simulates a browser without WebGL
  - `?ambient=off` disables decorative idle motion
  - `?people=off` hides the employees (benchmark comparison)
- **Employees** come from the backend (`/api/employees`). With the backend offline, the
  office shows no people and the HUD says "Roster unavailable"; nothing is invented.
  `make test-e2e` starts its own backend on port 18200 with a throwaway database and
  builds into `.next-e2e`, so it never touches your dev data or build.
- **Diagnostics:** `window.__NEXUS_PERF__` holds live renderer counters.
  `window.__NEXUS_OFFICE__` exposes read-only state, the camera and a few test actions.
- **Dev mode noise.** React Strict Mode double-mounts the canvas in development. This
  logs "Attempted to synchronously unmount a root" for the room labels. It doesn't
  happen in production builds, and the e2e tests run against production.

## Chat and live updates

- **Chat** lives at `/chat`. Deep links: `/chat?to=employee:<id>`,
  `/chat?to=department:<key>` (a new conversation, created on the first send),
  `/chat?c=<conversation id>&m=<message id>` (open and highlight a message).
- **API:** `GET/POST /api/conversations` (`?q=` searches titles, messages and file
  names), `PATCH/DELETE /api/conversations/{id}`, `GET/POST …/{id}/messages`
  (multipart: `content` + `files`), `POST …/{id}/reply` (try again), `POST …/{id}/stop`,
  `GET /api/attachments/{id}` (always a download), `GET/POST /api/tasks`,
  `PATCH /api/tasks/{id}`.
- **Live events:** `GET /api/events` is a Server-Sent Events stream
  (`curl -N localhost:3000/api/events` to watch it). Events: `employee.updated`,
  `roster.changed`, `conversation.updated|deleted`, `message.created|updated`,
  `message.token`, `reply.state`, `task.updated`, plus a `: ping` every 15 s. The
  backend ends open streams when it is asked to exit, so `--reload` stays fast.
- **Every reply is a real model request** that counts against the daily budgets. The
  tests never call NVIDIA: unit tests use `httpx.MockTransport`, e2e uses
  `backend/tests/fake_provider.py`.

## Workflows

- **API:** `GET/POST /api/workflows` (`objective`, or `source_message_id` /
  `source_task_id`; optional `max_calls`), `GET /api/workflows/{id}` (plan, tasks,
  timeline, report, estimate), `POST …/{id}/approve` (`{"exclude": [assignment ids]}`),
  `POST …/{id}/cancel`, `POST …/{id}/resume`, `POST …/{id}/tasks/{task_id}/cancel`.
- Every agent step is a real model request through the AI gateway (purposes
  `workflow_plan`, `workflow_breakdown`, `workflow_work`, `workflow_review`,
  `workflow_summary`, `workflow_report` in the usage dashboard).
- **Tests** never call NVIDIA: `tests/fake_agents.py` answers each step format with a
  valid canned reply (used by `test_workflows.py` and by the e2e fake provider).

## Apps

- **Pages:** `/apps` (list, new app) and `/apps/<id>` (design, files, run, changes).
  "Build as app" on an owner's chat message starts one from that message.
- **API:** `GET/POST /api/apps` (`description`, or `source_message_id`; optional
  `max_calls`), `GET /api/apps/{id}[?version=n]`, `POST …/{id}/approve`, `…/cancel`,
  `…/resume`, `POST …/{id}/changes` (`{"request": "…"}` → a new version),
  `DELETE …/{id}`, `GET …/{id}/versions/{n}/file?path=…` (content as JSON),
  `GET …/{id}/versions/{n}/download` (zip), `POST …/{id}/versions/{n}/run`
  (`{"tree_sha256": "…"}` — the owner's approval of that exact version),
  `POST /api/apps/runs/{run_id}/stop`, `GET /api/apps/runtime`.
- **Model requests:** purposes `app_plan`, `app_change`, `app_file`, `app_review`,
  `app_delivery` in the usage dashboard. A first build costs 1 (design) + one per file
  + 2 (review, delivery note), plus one per file that is fixed.
- **Running apps** needs the sandbox (`bwrap`, `systemd-run --user`), `python3` in
  `/usr/bin`, `uv` for apps with a `requirements.txt` and Node.js for Node/React apps.
  A running app is at `http://localhost:8100` (`NEXUS_PREVIEW_PORT`), on this computer
  only. Each app's folder is `backend/var/apps/<id>/` (`NEXUS_APPS_DIR`): `work/` (its
  files, `.venv`, `node_modules`, `data/`), `ctl/` (sockets) and `state/`.
- **Stacks** live in `backend/app/apps/stacks.py`: add one there (required files, rules
  for the engineers, install/build/start commands). The registries an install may
  reach are `REGISTRIES` in `backend/app/apps/runtime.py`.
- **Tests** never call NVIDIA: `tests/fake_agents.py` answers the app formats with a
  small real notes app. `tests/test_apps.py` covers the build engine,
  `tests/test_app_runtime.py` the sandboxed run (skipped without bubblewrap). To also
  install real packages from PyPI and npm for all three stacks:
  `NEXUS_TEST_APP_INSTALLS=1 uv run pytest tests/test_app_runtime.py -k real`.

## Voice

- **Install models** in Settings → Voice (or `POST /api/voice/models/{id}/install`).
  They are downloaded once from Hugging Face at a pinned revision, verified by SHA-256,
  and stored in `backend/var/voice/` (`NEXUS_VOICE_DIR`). Remove them there or with the
  Remove button.
- **API:** `GET /api/voice`, `PATCH /api/voice/settings`,
  `POST /api/voice/transcribe` (multipart `audio`, optional `language` auto|en|ar),
  `GET /api/voice/messages/{id}/speech` (what would be read aloud, in parts),
  `POST /api/voice/speak` (`{text, language?, employee_id?}` → WAV),
  `GET /api/attachments/{id}?play=1` (voice recordings, inline).
- The microphone only works on a secure page: `http://localhost` or HTTPS (not a LAN IP
  over plain HTTP).
- **Tests:** e2e sets `NEXUS_VOICE_FAKE=1` (stand-in engines, test env only) and runs
  Chrome with a fake microphone. To run the real round-trip test, point
  `NEXUS_TEST_VOICE_MODELS` at a folder of installed models, e.g.
  `NEXUS_TEST_VOICE_MODELS=var/voice uv run pytest -k real`.

## Database and migrations

- Models live in `backend/app/models/`. Import each new model module in
  `app/models/__init__.py` so autogenerate can see it.
- After changing models, run `make migration name="add departments"` and **review the
  generated file**. Then run `make migrate`.
- `tests/test_migrations.py` fails if the models and migrations drift apart, and also
  checks upgrade → downgrade → upgrade.
- To reset the local database, stop the servers, delete `backend/var/nexus.db*`, then
  run `make migrate`. This deletes all local data.

## Testing

- **Backend:** `pytest` with `httpx.ASGITransport`. Each test gets its own temporary
  SQLite database and hermetic settings that ignore `.env` and shell secrets.
- **Frontend:** Vitest with jsdom and Testing Library, using a mocked `fetch`.
- **Repository hygiene:** `tests/test_repo_hygiene.py` fails on anything that looks
  like an API key or private key, and on any email address outside `example.com`.
  Build fake secrets in tests by concatenation (`"nvapi-" + "x" * 30`) so the scanner
  doesn't flag the test itself.
- **Email:** `tests/fake_mail.py` is a local SMTP (aiosmtpd) + minimal IMAP server with
  failure modes (reject, temporary failure, connection dropped mid-send, bad recipient,
  IMAP down). Backend tests start it per test; Playwright starts it standalone on ports
  18325 (SMTP), 18326 (IMAP) and 18327 (a JSON control port that also serves a fake
  Brevo API under `/v3`). No test sends real mail.
- **End-to-end:** `make smoke`.

## Logging

- Every log line is structured: timestamp, level, logger, event, plus the `request_id`
  bound to the request.
- Keys that look sensitive (`*api_key*`, `*token*`, `*secret*`, `*password*`,
  `authorization`, ...) and values that look like secrets (`nvapi-…`, `sk-…`, bearer
  tokens, ...) are replaced with `[REDACTED]` before rendering.
- Even with redaction in place, never log secrets deliberately.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Console shows **Backend offline** | Start `make dev`; check `[api]` lines for errors |
| Readiness shows **Migrations pending** | `make migrate` |
| `Port 8000/3000 is already in use` | Another `make dev` is running: `ss -ltnp \| grep -E ':(3000\|8000)'` |
| `next dev` refuses to start (lock) | Only one `next dev` per project; stop the other instance |
| Proxy still points to the old backend after changing `NEXUS_BACKEND_URL` | Restart `make dev` or rebuild (`make build`) |
| `secret_key_missing` warning at startup | Run `make setup` (it fills `NEXUS_SECRET_KEY` without touching other values) |
