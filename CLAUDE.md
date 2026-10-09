# NEXUS AI — agent guide

NEXUS AI is a local virtual corporation: a Next.js 16 / React 19 frontend, FastAPI
backend, SQLite/PostgreSQL metadata, NVIDIA-compatible inference, a 3D office, and real
approval-gated employee workflows.

## Start here

1. Read `docs/STAGES.md` for the 16-stage product roadmap.
2. For Data Center or Digital Vault work, read `docs/DATA_CENTER.md` and
   `docs/DC_HANDOFF.md` before editing anything.
3. Read only the task-relevant guide under `docs/claude/`:
   - `stage-workflow.md` — stage gates, commits and reports
   - `principles.md` — truth, security and approval rules
   - `conventions.md` — stack and code conventions
   - `testing.md` — fakes and verification gates
   - `gotchas.md` — known races, proxy, WSL and 3D pitfalls
   - `environment.md` — machine and owner-specific constraints

## Non-negotiable rules

- Work on one approved stage at a time. Implement, test, inspect visuals, document,
  make one local commit, then stop for approval. Never infer approval for the next stage.
- The Data Center uses its own DC-1–DC-8 approval track and does not advance the global
  16-stage roadmap. Current handoff state is in `docs/DC_HANDOFF.md`.
- Never fabricate files, activity, metrics, progress or success. Missing evidence must
  remain unavailable/failed and be logged truthfully.
- Enforce permissions, limits and approvals in backend code, not prompts or hidden UI.
- Keep secrets out of source, logs, browser payloads and screenshots.
- Never push. Create at most one local Git commit for a completed stage.
- Preserve unrelated user changes and do not kill servers you did not start.
- On Windows, run backend/Python work only in an isolated WSL copy such as
  `/root/nexus-ai-dev`; never touch the owner's `/root/nexus-ai` runtime data.

## Main commands

```bash
./start.sh        # local app: backend :8000, frontend :3000
make lint         # Ruff, ESLint, TypeScript
make test         # pytest and Vitest
make build        # production frontend build
make smoke        # isolated API/page/proxy smoke checks
make test-e2e     # Playwright with fake AI; never the real provider
```

## Repository map

- `backend/app/` — APIs, services, workflows, apps, sandbox, storage and AI gateway
- `frontend/src/` — routes, UI, state and 3D world
- `docs/ARCHITECTURE.md` — implemented architecture and security boundaries
- `docs/DEVELOPMENT.md` — setup, configuration and troubleshooting
- `docs/adr/` — durable architecture decisions
