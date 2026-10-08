# NEXUS AI

**Your Corporation. Your AI Workforce.**

NEXUS AI is a virtual corporation operated by specialised AI agents and shown as an
interactive 3D headquarters. Every department, employee, desk and meeting room maps to
real system functionality: real tasks, real model calls, real approvals. Nothing on
screen is simulated.

> **Status: Stage 1 of 16 — Foundation & architecture.** The application skeleton,
> health checks, database migrations, logging and documentation are in place. The 3D
> office arrives in Stage 2. See [`docs/STAGES.md`](docs/STAGES.md).

## Quick start

Prerequisites: **Node.js 20.9+**, **uv** ([install](https://docs.astral.sh/uv/getting-started/installation/)),
`make`, and Linux or macOS. Python 3.12 is managed by uv.

```bash
make setup   # install dependencies, create .env files (generates a local secret key), migrate DB
make dev     # backend on :8000 + frontend on :3000
```

Open **http://localhost:3000**. API docs: **http://localhost:3000/api/docs**.

```bash
make test    # backend (pytest) + frontend (vitest)
make lint    # ruff + eslint + tsc
make smoke   # boot both servers and verify health end-to-end
make help    # every command
```

## Documentation

| Document | What it covers |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Target system architecture for all 16 stages, security model, performance budget |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Setup, configuration, scripts, migrations, testing, troubleshooting |
| [`docs/STAGES.md`](docs/STAGES.md) | Stage plan, acceptance criteria and stage reports |
| [`docs/adr/`](docs/adr) | Architecture decision records |

## Principles

- **Backend is the source of truth.** The 3D office only reflects real state. Ambient
  animation is kept visibly separate from work status.
- **The owner approves anything sensitive.** External email, publishing, spending and
  deployments require approval, and the backend enforces it.
- **Secrets stay server-side.** No credential ever reaches the browser, the logs or git.
- **No mandatory paid services.** NVIDIA's accessible inference is the primary AI
  provider. A paid fallback is never activated silently.
- **Runs locally.** Everything binds to `127.0.0.1` by default.
