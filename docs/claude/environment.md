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
- **Windows 11 PC (current):** the repository is at `C:\Users\<user>\Desktop\Nexus-Ai`
  and is edited there; `start.bat` runs it in WSL2 (Ubuntu, as root) from a copy at
  `~/nexus-ai`. Smart App Control blocks unsigned compiled Python packages, so **nothing
  Python runs on Windows** (no `uv run`, no pytest, no ruff). Develop like this:
  - sync the Windows folder to a second copy and run there:
    `NEXUS_WSL_DIR=~/nexus-ai-dev bash <(tr -d '\r' < scripts/wsl-start.sh) --sync-only`,
    then `cd ~/nexus-ai-dev/backend && uv run --frozen pytest …` (never touch `~/nexus-ai`,
    the owner's running copy);
  - format from WSL directly on the Windows files (`ruff format /mnt/c/…`);
  - never run a mutating git command from WSL on `/mnt/c/…` (line endings differ);
    commit from Windows git;
  - Google Chrome is installed in WSL for Playwright (`E2E_SOFTWARE_GL=1`);
  - the sandbox (bubblewrap, systemd user session) works in that WSL;
  - `make` is not installed there: run the commands behind each Makefile target
    directly, with `~/.local/share/nexus-ai-wsl/node/bin` and `~/.local/bin` on `PATH`;
  - WSL stops the distro when nothing is running in it and `/tmp` is empty on the next
    start, so keep logs you need later under `$HOME`, and a background run dies when the
    `wsl.exe` that started it exits;
  - in Git Bash on Windows a bare `python` never returns and tools such as `file`,
    `sort` and `wc` are blocked; do that work inside WSL instead;
  - a clean-copy check: `git -c core.autocrlf=false archive "$(git write-tree)"` piped
    into `tar -x` in a new WSL folder gives exactly the staged files with LF endings.

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
