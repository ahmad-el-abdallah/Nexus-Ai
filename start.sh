#!/usr/bin/env bash
# Start NEXUS AI — backend and frontend together, in this one terminal.
#
#   ./start.sh            then open http://localhost:3000
#   ./start.sh --lan      also reachable from other devices on your network
#                         (http://<this machine's IP>:3000 — printed at startup)
#
# The first run installs everything (same as `make setup`). Logs from both servers
# appear here, prefixed [api] and [web]. Press Ctrl-C once to stop both.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

API_PORT=8000
WEB_PORT=3000

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

if [[ ! -f backend/.env || ! -d frontend/node_modules || ! -d backend/.venv ]]; then
  echo "▸ First run: installing dependencies (this takes a few minutes, once)…"
  ./scripts/setup.sh
fi

for port in "$API_PORT" "$WEB_PORT"; do
  if port_busy "$port"; then
    echo "✗ Port $port is already in use — NEXUS AI (or another app) is probably already running." >&2
    echo "  Open http://localhost:$WEB_PORT, or stop the other process first." >&2
    exit 1
  fi
done

exec ./scripts/dev.sh "$@"
