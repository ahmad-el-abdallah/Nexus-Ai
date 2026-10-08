#!/usr/bin/env bash
# One-time (and idempotent) local setup for NEXUS AI.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

step "Checking prerequisites"
command -v node >/dev/null || fail "Node.js 20.9+ is required: https://nodejs.org"
command -v npm  >/dev/null || fail "npm is required (ships with Node.js)"
command -v uv   >/dev/null || fail "uv is required: https://docs.astral.sh/uv/getting-started/installation/"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=9)?0:1)' \
  || fail "Node.js 20.9+ is required (found $(node --version))"
echo "node $(node --version) · npm $(npm --version) · $(uv --version)"

step "Installing backend dependencies (uv)"
(cd backend && uv sync --frozen)

step "Installing frontend dependencies (npm)"
(cd frontend && npm ci --no-fund --no-audit)

step "Preparing environment files"
if [[ ! -f backend/.env ]]; then
  cp backend/.env.example backend/.env
  echo "created backend/.env from template"
fi
if ! grep -qE '^NEXUS_SECRET_KEY=.+' backend/.env; then
  # 32 random bytes, url-safe base64 (Fernet-compatible). Generated locally, never committed.
  key="$(cd backend && uv run --frozen python -c 'import base64, os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())')"
  sed -i.bak "s|^NEXUS_SECRET_KEY=.*|NEXUS_SECRET_KEY=${key}|" backend/.env && rm -f backend/.env.bak
  echo "generated NEXUS_SECRET_KEY in backend/.env"
fi
chmod 600 backend/.env
if [[ ! -f frontend/.env ]]; then
  cp frontend/.env.example frontend/.env
  echo "created frontend/.env from template"
fi

step "Applying database migrations"
(cd backend && uv run --frozen alembic upgrade head)

printf '\n\033[1;32m✓ Setup complete.\033[0m Start NEXUS AI with: make dev\n'
