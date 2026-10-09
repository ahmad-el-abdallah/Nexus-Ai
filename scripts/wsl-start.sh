#!/usr/bin/env bash
# Runs NEXUS AI inside WSL2. start.bat calls this from the Windows checkout; on Linux or
# macOS use ./start.sh instead.
#
# Windows Smart App Control blocks the unsigned compiled Python packages the backend
# needs, so on Windows the servers run in Linux. The Windows folder stays the place where
# the code is edited: every start copies it (tracked files plus new files that aren't
# ignored, uncommitted changes included) to a run copy on the Linux filesystem, with
# Linux line endings. Dependencies, backend/.env and backend/var (database, voice
# models, sandbox runs) live only in the run copy and are never overwritten.
#
#   --sync-only   copy the project and stop (nothing is started). With
#                 NEXUS_WSL_DIR=~/some-other-folder this makes a second copy, e.g. to run
#                 the tests without touching the copy the servers run from.
set -euo pipefail

SRC="$(pwd)"
RUN="${NEXUS_WSL_DIR:-$HOME/nexus-ai}"
STATE="${XDG_DATA_HOME:-$HOME/.local/share}/nexus-ai-wsl"
NODE_DIR="$STATE/node"
NODE_DIST="https://nodejs.org/dist/latest-v22.x"
# Each run copy has its own pair of git indexes, so a second copy never disturbs the first.
INDEXES="$STATE/copies/${RUN//\//_}"

SYNC_ONLY=0
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == --sync-only ]]; then SYNC_ONLY=1; else ARGS+=("$arg"); fi
done

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ -f "$SRC/start.sh" && -d "$SRC/.git" ]] || fail "Run start.bat from the NEXUS AI folder."

missing=()
for tool in git curl tar sha256sum; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
((${#missing[@]} == 0)) \
  || fail "Missing in Linux: ${missing[*]}. Install with: sudo apt update && sudo apt install -y git curl tar coreutils"

mkdir -p "$STATE/objects" "$INDEXES" "$RUN"
# The indexes of the default copy used to live directly in $STATE.
if [[ -f "$STATE/run.index" && ! -f "$INDEXES/run.index" && "$RUN" == "$HOME/nexus-ai" ]]; then
  mv "$STATE/run.index" "$STATE/snapshot.index" "$INDEXES/"
fi
export PATH="$NODE_DIR/bin:$HOME/.local/bin:$PATH"
# The documented Python version; uv downloads it if the distribution doesn't have it.
export UV_PYTHON="${UV_PYTHON:-3.12}"

# Node.js 20.9+ with a Linux npm. WSL also puts the Windows PATH in ours, where the
# Windows npm script would be found and fail, so anything under /mnt/ doesn't count.
node_ok() {
  local npm_path
  command -v node >/dev/null || return 1
  npm_path="$(command -v npm || true)"
  [[ -n "$npm_path" && "$npm_path" != /mnt/* ]] || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=9)?0:1)'
}

install_node() {
  local arch sums file tmp
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) fail "Unsupported CPU for the Node.js download: $(uname -m)" ;;
  esac
  sums="$(curl -fsSL "$NODE_DIST/SHASUMS256.txt")"
  file="$(awk -v suffix="-linux-$arch.tar.gz" 'index($2, suffix) { print $2; exit }' <<<"$sums")"
  [[ -n "$file" ]] || fail "No Node.js download found for linux-$arch at $NODE_DIST"
  tmp="$(mktemp -d)"
  curl -fSL --progress-bar -o "$tmp/$file" "$NODE_DIST/$file"
  (cd "$tmp" && awk -v f="$file" '$2 == f' <<<"$sums" | sha256sum -c --quiet -) \
    || fail "The Node.js download did not match its checksum."
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xzf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
}

if ! node_ok; then
  step "Installing Node.js 22 for Linux (into $NODE_DIR, no administrator rights)"
  install_node
  node_ok || fail "Node.js was installed but doesn't run: $NODE_DIR/bin/node"
fi

if ! command -v uv >/dev/null; then
  step "Installing uv (into ~/.local/bin, no administrator rights)"
  curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh
  command -v uv >/dev/null || fail "uv was installed but isn't in ~/.local/bin"
fi

# Copy the Windows checkout to the run copy with git, reading the repository without
# writing to it: new objects go to our own store, and both indexes are ours.
#   1. Snapshot the working folder (what `git add -A` would stage, so ignored files such
#      as .env, var/ and node_modules/ are left out), normalising CRLF to LF.
#   2. Check that snapshot out into the run copy: changed files are replaced, files
#      removed on Windows are removed, everything else there is left alone.
sync_copy() {
  local tree
  local -a src=(git -c safe.directory='*' -c core.filemode=false -c core.autocrlf=true)
  local -a run=(git -c safe.directory='*' -c core.autocrlf=false -c core.eol=lf)
  export GIT_DIR="$SRC/.git"
  export GIT_OBJECT_DIRECTORY="$STATE/objects"
  export GIT_ALTERNATE_OBJECT_DIRECTORIES="$SRC/.git/objects"

  cd "$SRC"
  # Starting from HEAD keeps the executable bits git recorded (Windows has none).
  [[ -f "$INDEXES/snapshot.index" ]] \
    || GIT_INDEX_FILE="$INDEXES/snapshot.index" GIT_WORK_TREE="$SRC" "${src[@]}" read-tree HEAD
  GIT_INDEX_FILE="$INDEXES/snapshot.index" GIT_WORK_TREE="$SRC" "${src[@]}" add -A 2>/dev/null
  tree="$(GIT_INDEX_FILE="$INDEXES/snapshot.index" GIT_WORK_TREE="$SRC" "${src[@]}" write-tree)"

  cd "$RUN"
  GIT_INDEX_FILE="$INDEXES/run.index" GIT_WORK_TREE="$RUN" "${run[@]}" read-tree --reset -u "$tree"

  unset GIT_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
}

step "Copying the project to Linux ($RUN)"
sync_copy
cd "$RUN"
chmod +x start.sh scripts/*.sh
((SYNC_ONLY)) && exit 0

command -v bwrap >/dev/null \
  || echo "note: running employee code (▶ Run) needs bubblewrap: sudo apt install -y bubblewrap"

exec ./start.sh "${ARGS[@]}"
