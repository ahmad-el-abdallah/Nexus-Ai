#!/usr/bin/env bash
# End-to-end smoke test: boots backend + frontend against a throwaway database,
# checks health endpoints directly and through the Next.js proxy, then tears down.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

API_PORT="${SMOKE_API_PORT:-8000}"
WEB_PORT="${SMOKE_WEB_PORT:-3000}"
API="http://127.0.0.1:$API_PORT"
WEB="http://127.0.0.1:$WEB_PORT"
TMP="$(mktemp -d)"
LOGS="$ROOT/.artifacts/smoke"
mkdir -p "$LOGS"
failures=0

for port in "$API_PORT" "$WEB_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "Port $port is already in use — stop 'make dev' before running the smoke test." >&2
    exit 1
  fi
done

kill_tree() {  # stop a process and all of its descendants (npm/uv spawn children)
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  [[ -n "${API_PID:-}" ]] && kill_tree "$API_PID"
  [[ -n "${WEB_PID:-}" ]] && kill_tree "$WEB_PID"
  wait 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

export NEXUS_DATABASE_URL="sqlite+aiosqlite:///$TMP/smoke.db"
export NEXUS_STORAGE_ROOT="$TMP/storage"
export NEXUS_ENV=test
export NEXUS_PORT="$API_PORT"
export NEXUS_BACKEND_URL="$API"   # read by `next dev` at startup

(cd backend && uv run --frozen alembic upgrade head) >"$LOGS/migrate.log" 2>&1
(cd backend && exec uv run --frozen python -m app) >"$LOGS/api.log" 2>&1 &
API_PID=$!
(cd frontend && exec ./node_modules/.bin/next dev --hostname 127.0.0.1 --port "$WEB_PORT") >"$LOGS/web.log" 2>&1 &
WEB_PID=$!

wait_for() {  # url, seconds
  for _ in $(seq 1 "$2"); do
    curl -fs -o /dev/null "$1" && return 0
    sleep 1
  done
  return 1
}

check() {  # name, expected-status, url, [grep pattern]
  local name=$1 expected=$2 url=$3 pattern=${4:-} body code
  body="$(curl -s -D "$TMP/headers" -w '\n%{http_code}' "$url" || true)"
  code="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [[ "$code" == "$expected" ]] && { [[ -z "$pattern" ]] || grep -qE "$pattern" <<<"$body$(cat "$TMP/headers")"; }; then
    printf '  \033[32mPASS\033[0m  %s (%s)\n' "$name" "$code"
  else
    printf '  \033[31mFAIL\033[0m  %s (got %s, expected %s%s)\n' "$name" "$code" "$expected" "${pattern:+ matching /$pattern/}"
    failures=$((failures + 1))
  fi
}

echo "Waiting for servers…"
wait_for "$API/api/health/live" 60 || { echo "backend did not start; see $LOGS/api.log"; exit 1; }
wait_for "$WEB/healthz" 120 || { echo "frontend did not start; see $LOGS/web.log"; exit 1; }

echo "Backend (direct):"
check "GET /api/health/live"  200 "$API/api/health/live"  '"status":"ok"'
check "GET /api/health/ready" 200 "$API/api/health/ready" '"status":"ok"'
check "GET /api/system/info"  200 "$API/api/system/info"  '"installation_id":"[0-9a-f]{32}"'
check "GET /api/storage/overview" 200 "$API/api/storage/overview" '"status":"metadata_ready"'

printf 'smoke file contents\n' >"$TMP/vault-smoke.txt"
upload="$(curl -s -w '\n%{http_code}' -F 'file=@'"$TMP/vault-smoke.txt"';type=text/plain' "$API/api/storage/workspaces/ws_company/files" || true)"
upload_code="${upload##*$'\n'}"
upload_body="${upload%$'\n'*}"
upload_id="$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' <<<"$upload_body")"
if [[ "$upload_code" == "201" && -n "$upload_id" ]]; then
  printf '  \033[32mPASS\033[0m  %s\n' "POST/download/delete Digital Vault file"
  if ! curl -fs "$API/api/storage/entries/$upload_id/download" -o "$TMP/vault-downloaded.txt" || ! cmp -s "$TMP/vault-smoke.txt" "$TMP/vault-downloaded.txt"; then
    printf '  \033[31mFAIL\033[0m  %s\n' "Digital Vault download bytes differ"; failures=$((failures + 1))
  fi
  if ! curl -fs -X DELETE "$API/api/storage/entries/$upload_id" -o /dev/null; then
    printf '  \033[31mFAIL\033[0m  %s\n' "Digital Vault trash failed"; failures=$((failures + 1))
  fi
else
  printf '  \033[31mFAIL\033[0m  %s (got %s)\n' "POST Digital Vault file" "$upload_code"; failures=$((failures + 1))
fi

echo "Frontend:"
check "GET /healthz"          200 "$WEB/healthz"          '"status":"ok"'
check "GET / (headquarters)" 200 "$WEB/"                 'NEXUS AI'
check "GET /system"           200 "$WEB/system"           'System status'
check "GET /departments"      200 "$WEB/departments"      'Departments'
check "GET /org"              200 "$WEB/org"              'Org chart'
check "GET /settings/ai"      200 "$WEB/settings/ai"      'Settings'
check "GET /chat"             200 "$WEB/chat"             'Chat'
check "GET /settings/voice"   200 "$WEB/settings/voice"   'Settings'
check "GET /workflows"        200 "$WEB/workflows"        'Workflows'
check "GET /apps"             200 "$WEB/apps"             'Apps'
check "GET /email"            200 "$WEB/email"            'Email'
check "GET /settings/email"   200 "$WEB/settings/email"   'Email accounts'

echo "Frontend → backend proxy:"
check "GET /api/health/ready" 200 "$WEB/api/health/ready" 'x-request-id'
check "GET /api/system/info"  200 "$WEB/api/system/info"  '"name":"NEXUS AI"'
check "GET /api/departments"  200 "$WEB/api/departments"  '"key":"knowledge"'
check "GET /api/storage/overview" 200 "$WEB/api/storage/overview" '"writes_enabled":true'
check "GET /api/ai/settings"  200 "$WEB/api/ai/settings"  '"provider":"nvidia"'
check "GET /api/conversations" 200 "$WEB/api/conversations" '^\['
check "GET /api/tasks"        200 "$WEB/api/tasks"        '^\['
check "GET /api/voice"        200 "$WEB/api/voice"        '"stt_model"'
check "GET /api/workflows"    200 "$WEB/api/workflows"    '^\['
check "GET /api/email/accounts" 200 "$WEB/api/email/accounts" '"accounts":\['
check "GET /api/email/providers" 200 "$WEB/api/email/providers" '"key":"gmail"'
check "GET /api/runs/capabilities" 200 "$WEB/api/runs/capabilities" '"limits"'
check "GET /api/apps"         200 "$WEB/api/apps"         '^\['
check "GET /api/apps/runtime" 200 "$WEB/api/apps/runtime" '"registries"'
check "GET /api/employees (profile roster)" 200 "$WEB/api/employees" '"skills"'
# The live event stream never ends by itself: read its first event, then hang up.
events="$(curl -sN --max-time 3 "$WEB/api/events" || true)"
if grep -q '^event: ready' <<<"$events"; then
  printf '  \033[32mPASS\033[0m  %s\n' "GET /api/events (live stream through the proxy)"
else
  printf '  \033[31mFAIL\033[0m  %s\n' "GET /api/events (no ready event through the proxy)"
  failures=$((failures + 1))
fi

echo "Backend stopped (proxy must not pretend it is healthy):"
kill_tree "$API_PID"; wait "$API_PID" 2>/dev/null || true; API_PID=
code="$(curl -s -o /dev/null -w '%{http_code}' "$WEB/api/health/ready" || true)"
if [[ "$code" =~ ^(5..|000)$ ]]; then
  printf '  \033[32mPASS\033[0m  proxy reports failure when backend is down (%s)\n' "$code"
else
  printf '  \033[31mFAIL\033[0m  proxy returned %s with backend down\n' "$code"; failures=$((failures + 1))
fi

if (( failures )); then
  echo "Smoke test failed ($failures). Logs: $LOGS"; exit 1
fi
echo "Smoke test passed."
