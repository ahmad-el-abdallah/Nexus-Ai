# Known pitfalls (learned the hard way)

## Backend
- **Commit status + timeline event + chat message in one transaction**
  (`Orchestrator._commit_with`), or clients/tests see one without the other.
- **Stop and await in-flight steps before cancelling or shutting down**
  (`Orchestrator._halt`), otherwise a finishing step overwrites "cancelled" or the event
  loop hangs on a closed database.
- Publish task updates from a fresh read (`_publish_task`): server-set timestamps are
  expired after commit and lazy-loading them outside async context crashes.
- Uvicorn waits for open SSE streams on shutdown → `install_shutdown_hook()` closes them;
  `timeout_graceful_shutdown=3` is the backstop.
- SSE through `next start` is gzip-buffered unless the response has
  `Cache-Control: no-transform`.
- faster-whisper 1.2.1 can't decode audio with PyAV 19 → the app decodes audio itself
  (`voice/engines.py:decode_audio`).
- The AI base URL is stored in the DB (`ai_provider_settings.base_url`), not only in env —
  a copied dev DB still points at real NVIDIA.
- Reasoning models may echo the format tag or spend all tokens thinking; free-text
  results go through `prompts.clean_text`, empty replies are retried.

- Email: `smtplib.SMTP.data()` does **not** raise on a 4xx/5xx final reply — check the
  code. Gmail hangs up after a rejected password (no 535), and aiosmtpd's authenticator
  must return `AuthResult(..., handled=False)` or the client never gets a reply.
- Email accounts store the preset key (`gmail`) in `provider`; OAuth endpoints are keyed
  by `preset.oauth` (`google`).

- Piper adds random variation to every synthesis, so the opt-in real round-trip voice
  test (`NEXUS_TEST_VOICE_MODELS`) can miss its 85 % word match on some runs; the
  language assertion is the stable part.
- English voices by gender live in `voice/speakers.py` (generated from LibriSpeech
  SPEAKERS.TXT + measured pitch); don't pick speakers from `avatar_seed` directly.

- **SQLite reads in one session are not a snapshot**: each query sees the latest commit.
  A detail endpoint that loads the parent row first and the status later can return the
  new status with old details. Read the status-bearing row **first**
  (`apps.builder.app_summary`, `api/apps._detail`) and everything else after it.
- `created_at` (`func.now()`) has one-second resolution in SQLite: two rows made in the
  same second have no order. Sort "the latest" by a timestamp set in code
  (`AppRun.approved_at`).
- Apps sandbox: `asyncio.Server.wait_closed()` waits for open connections — never await
  it while the process on the other end is still alive. A running app can plant symbolic
  links in its own folder: write and delete through `apps/files.py` only. Programs in
  the sandbox need `/etc/hosts` and `/etc/passwd` (bound from `_support/`), and installs
  need their caches on disk (`/work/.cache`), not in the sandbox's tmpfs (it counts as
  memory). A reply whose closing code fence shares the last line is still complete.

## Frontend / 3D
- drei `<Html>` creates a React root per label → "synchronously unmount a root" errors in
  dev Strict Mode. Use `ScreenAnchors` + `ScreenLabel`.
- Postprocessing disables renderer tone mapping (add a ToneMapping effect); double-sided
  transparent materials need `forceSinglePass`; don't share one material across plain,
  instanced and instance-coloured meshes.
- Headless Chrome needs `--use-angle=gl --enable-gpu --ignore-gpu-blocklist` for the real
  GPU (default SwiftShader is ~10× slower).
- The HQ top bar is tight at 1440 px: keep chips short and `whitespace-nowrap`.

## Shell
- Uncommitted work can disappear into a **"Teleport auto-stash"** (`git stash list`) when
  a session is moved to/from the cloud. Check the stash before recreating lost files.
- Don't use `pkill -f <pattern>` (it matches your own shell); kill by PID from
  `ss -ltnp`.
- `sqlite3` CLI isn't installed; copy DBs with Python's `sqlite3` `backup()`.
- Department names differ from keys (e.g. `engineering` = "Software Engineering").
