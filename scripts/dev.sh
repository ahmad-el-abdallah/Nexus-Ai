#!/usr/bin/env bash
# Runs the backend (http://127.0.0.1:8000) and frontend (http://127.0.0.1:3000) together.
# Ctrl-C stops both.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[[ -f backend/.env && -d frontend/node_modules ]] || { echo "Run 'make setup' first." >&2; exit 1; }

(cd backend && uv run --frozen alembic upgrade head)

trap 'trap - INT TERM EXIT; kill 0 2>/dev/null' INT TERM EXIT

(cd backend && exec uv run --frozen python -m app --reload) 2>&1 | sed -u 's/^/[api] /' &
(cd frontend && exec npm run dev --silent) 2>&1 | sed -u 's/^/[web] /' &

echo "[dev] NEXUS AI → http://localhost:3000   (API docs: http://localhost:3000/api/docs)"
wait -n
