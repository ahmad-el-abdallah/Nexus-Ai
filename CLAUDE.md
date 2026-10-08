# NEXUS AI — Claude guide

A 3D virtual corporation run by AI agents: Next.js 16 frontend + FastAPI backend, NVIDIA
inference, built in **16 stages**. Progress and reports: `docs/STAGES.md`.

## Non-negotiable rules
- **One stage at a time.** Finish → test → inspect visuals → report → **STOP** and ask
  for approval. Never start the next stage without the owner's explicit "yes"/"go".
  Details and report format: `docs/claude/stage-workflow.md`.
- **Nothing fake.** No invented stats, progress, work or data; show "Not enough data"
  instead. Approvals and limits are enforced in backend code, not prompts. No secrets in
  code, logs, API responses or the frontend; no hardcoded email address. Full list:
  `docs/claude/principles.md`.
- **Never push.** One local git commit per completed stage.
- Don't kill servers you didn't start; the owner often runs `./start.sh` / `make dev`.

## Commands
```bash
./start.sh        # backend :8000 + frontend :3000 in one terminal (Ctrl-C stops both)
make lint         # ruff + eslint + tsc
make test         # pytest + vitest
make test-e2e     # Playwright (own servers on 3200/18200/18300, fake AI, never NVIDIA)
make smoke        # boots both servers and checks every page and API
make migration name="…" && make migrate
```

## Where things are
- `backend/app/` — `api/`, `services/`, `orchestration/` (workflows), `voice/`, `ai/` (gateway)
- `frontend/src/` — `components/`, `lib/`, `world/` (3D office), `app/` (routes)
- Architecture: `docs/ARCHITECTURE.md` · Dev setup: `docs/DEVELOPMENT.md` · Decisions: `docs/adr/`

## Read before working on…
- Code style, stack versions, Next.js 16 / React rules → `docs/claude/conventions.md`
- Tests, fakes, verification checklist → `docs/claude/testing.md`
- Known pitfalls (hangs, races, proxies, 3D) → `docs/claude/gotchas.md`
- Machine, owner preferences, real NVIDIA facts → `docs/claude/environment.md`
