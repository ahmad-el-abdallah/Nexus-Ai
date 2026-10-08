#!/usr/bin/env bash
# Runs the backend (http://127.0.0.1:8000) and frontend (http://127.0.0.1:3000) together.
# Ctrl-C stops both.
#
#   --lan   also serve the frontend to other devices on this network (no login — anyone on
#           the network can use NEXUS, so only use it on a network you trust). The backend
#           stays on 127.0.0.1; the browser reaches it through the frontend's /api proxy.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[[ -f backend/.env && -d frontend/node_modules ]] || { echo "Run 'make setup' first." >&2; exit 1; }

LAN=0
for arg in "$@"; do
  case "$arg" in
    --lan) LAN=1 ;;
    *) echo "Unknown option: $arg (supported: --lan)" >&2; exit 2 ;;
  esac
done
[[ "${NEXUS_LAN:-0}" == 1 ]] && LAN=1

LAN_IPS=""
if [[ "$LAN" == 1 ]]; then
  # Under WSL2 the network sees the Windows host, so start.bat passes its addresses.
  LAN_IPS="${NEXUS_LAN_HOSTS:-$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' | tr '\n' ' ' || true)}"
  export NEXUS_WEB_HOST=0.0.0.0 NEXUS_DEV_ORIGINS="$LAN_IPS"
fi

(cd backend && uv run --frozen alembic upgrade head)

trap 'trap - INT TERM EXIT; kill 0 2>/dev/null' INT TERM EXIT

(cd backend && exec uv run --frozen python -m app --reload) 2>&1 | sed -u 's/^/[api] /' &
(cd frontend && exec npm run dev --silent) 2>&1 | sed -u 's/^/[web] /' &

echo "[dev] NEXUS AI → http://localhost:3000   (API docs: http://localhost:3000/api/docs)"
if [[ "$LAN" == 1 ]]; then
  for ip in $LAN_IPS; do echo "[dev] On your network → http://$ip:3000"; done
  echo "[dev] LAN mode: anyone on this network can open NEXUS (there is no login)."
  echo "[dev] Voice needs a secure page, so the microphone only works at http://localhost:3000."
fi
wait -n
