# NEXUS AI

**Your Corporation. Your AI Workforce.**

NEXUS AI is a virtual corporation operated by specialised AI agents and shown as an
interactive 3D headquarters. Every department, employee, desk and meeting room maps to
real system functionality: real tasks, real model calls, real approvals. Nothing on
screen is simulated.

> **Status: Stage 10 of 16 — Employee profiles & ratings.** Click a character in the 3D
> office (or an employee name in a department) to open their **profile** at
> `/employees/{id}`: identity, office, manager and team; owner-managed **skills**; active
> assignments and task history; an **evidence-based performance** panel computed only from
> real tasks, sandbox runs and reviews (and "Not enough data" when there's none); your own
> **ratings and feedback** with history; and a full **change history**. Email (Stage 9),
> workflows, chat, voice and the code sandbox keep working. The engineering team can
> also build whole web apps (**Apps**): the architect designs, you approve, each engineer
> writes the files of their role, and the stored app can be downloaded, run here in a
> sandbox, or changed. See [`docs/STAGES.md`](docs/STAGES.md).

> **Data Center feature track:** DC-4 is complete and awaiting approval for DC-5. The
> searchable, enterable Data Center room now appears beside Engineering with twelve
> racks and a live storage overview. The local Vault backend now provides validated,
> quota-limited file APIs plus dynamic department workspaces, actor-aware grants and
> validated task/app artifact links. It is tracked separately from the 16-stage roadmap
> and does not approve Stage 11.
> The browser file explorer is planned for DC-5. See
> [`docs/DATA_CENTER.md`](docs/DATA_CENTER.md).

## Quick start

Prerequisites: **Node.js 20.9+**, **uv** ([install](https://docs.astral.sh/uv/getting-started/installation/)),
`make`, and Linux or macOS. Python 3.12 is managed by uv.

**One command, one terminal:**

```bash
./start.sh   # first run installs everything; then backend :8000 + frontend :3000 together
```

Logs from both servers appear in that terminal (prefixed `[api]` / `[web]`); press
**Ctrl-C** once to stop both.

**On Windows:** double-click `start.bat`. It runs the servers inside WSL2 (it offers to
install WSL2 if it is missing) and sets up Node.js and uv there on the first run. See
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md#windows).

The same thing step by step (Linux/macOS):

```bash
make setup   # install dependencies, create .env files (generates a local secret key), migrate DB
make dev     # backend on :8000 + frontend on :3000
```

Open **http://localhost:3000** for the headquarters and **http://localhost:3000/system**
for live system status, **/apps** for apps built by engineering, **/departments** and **/org** for the organisation,
**http://localhost:3000/characters** for the character studio
(animation preview). API docs: **http://localhost:3000/api/docs**.

**Navigating the office:** drag to pan · right-drag to rotate · scroll to zoom · click a
room, its label or a person to focus it · search finds rooms and people · `G`/`2`/`All` buttons pick floors · ⌂ returns to the
overview. Keyboard: arrows/WASD pan, `Q`/`E` rotate, `+`/`-` zoom, `0` overview, `Esc`
deselect.

```bash
make test    # backend (pytest) + frontend (vitest)
make lint    # ruff + eslint + tsc
make smoke   # boot both servers and verify health end-to-end
make test-e2e  # browser tests of the 3D office (Playwright + your Chrome)
make bench URL=http://127.0.0.1:3000  # 3D frame-time benchmark on this GPU
make help    # every command
```

## Documentation

| Document | What it covers |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Target system architecture for all 16 stages, security model, performance budget |
| [`docs/DATA_CENTER.md`](docs/DATA_CENTER.md) | Data Center architecture, DC-1–DC-8 tracker, storage and security decisions |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Setup, configuration, scripts, migrations, testing, troubleshooting |
| [`docs/STAGES.md`](docs/STAGES.md) | Stage plan, acceptance criteria and stage reports |
| [`docs/adr/`](docs/adr) | Architecture decision records (stack, email sending) |

## Principles

- **Backend is the source of truth.** The 3D office only reflects real state. Ambient
  animation is kept visibly separate from work status.
- **The owner approves anything sensitive.** External email, publishing, spending and
  deployments require approval, and the backend enforces it.
- **Secrets stay server-side.** No credential ever reaches the browser, the logs or git.
- **No mandatory paid services.** NVIDIA's accessible inference is the primary AI
  provider. A paid fallback is never activated silently.
- **Runs locally.** Everything binds to `127.0.0.1` by default.
