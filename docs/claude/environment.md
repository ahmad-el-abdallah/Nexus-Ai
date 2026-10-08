# Environment and owner preferences

## Owner decisions
- Database: **SQLite** (`backend/var/nexus.db`) even though PostgreSQL 16 is installed.
- Git: one local commit per stage, identity "ahmad2"; never push.
- The NVIDIA key is in `backend/.env` (never print, log or ask for it).
- Speech models are installed by the owner from Settings → Voice (not pre-installed).

## Machine
- Linux, Intel UHD (CometLake) iGPU, 4 cores, 7.5 GB RAM — the 3D budget targets this.
  The owner's own Chrome often has the 3D office open, which skews benchmarks; compare
  A/B runs under the same conditions.
- Node 22, npm, uv, Python 3.12, Google Chrome.
- The owner may also use an ASUS TUF A15 (Windows → run inside WSL2; set Chrome to the
  NVIDIA GPU, keep it plugged in).

## Running servers
- Owner's dev: `./start.sh` or `make dev` → backend 8000 (`--reload`), frontend 3000
  (`next dev`; one instance per project dir).
- Previews/real checks: separate ports (backend 18200, `next start` on 3200 from
  `.next-e2e`), on a **copy** of the dev DB in the scratchpad.

## Real NVIDIA facts (owner's key)
- Default model `nvidia/nemotron-3-super-120b-a12b` (fast, reasoning). Also working:
  `nvidia/nemotron-3.5-lightning-30b-a3b`, `openai/gpt-oss-20b`, `z-ai/glm-5.3-flash` (slow).
- Many listed models return 404 "not available to account"; always verify before use.
- Defaults: daily budget 500 requests, concurrency 2, max output 1024 tokens.
