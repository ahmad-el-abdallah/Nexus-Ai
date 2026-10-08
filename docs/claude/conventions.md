# Code conventions

## Backend (Python 3.12, uv)
- FastAPI app factory: `uvicorn app.main:create_app --factory` / `python -m app [--reload]`.
  `create_app(settings, ai_transport=None, voice_transport=None)` — transports let tests
  replace the network.
- Settings: pydantic-settings, `NEXUS_` prefix, secrets as `SecretStr`.
- SQLAlchemy 2.1 async + aiosqlite (SQLite now; Postgres must stay possible). All
  timestamps use `UTCDateTime`. Alembic migrations are numbered `000N_name.py`, cleaned up
  after autogenerate (use `sa.DateTime(timezone=True)`, `sa.func.now()`), batch mode.
- structlog with secret redaction; every request has `X-Request-ID`.
- Ruff: format + check (E501 ignored). Avoid deprecated SQLAlchemy APIs
  (tests turn app DeprecationWarnings into errors).
- Live updates go through `app/core/events.py` (EventBus) → `GET /api/events` (SSE).
  Publish only state that is already committed.

## Frontend (Next.js 16, React 19, TypeScript 5.9.3 pinned, Tailwind 4)
- **Next 16 differs from older versions** — read `frontend/node_modules/next/dist/docs/`
  before Next-specific code. `cacheComponents` is on; dynamic params use
  `params.then(...)` inside `<Suspense>`; run `npx next typegen` before `tsc`.
- The browser only calls same-origin `/api/*` (Next rewrites proxy to FastAPI; the
  backend URL is baked at build time for `next start`).
- React compiler lint rules: no setState synchronously in effects, no ref access during
  render, no impure calls in render (`react-hooks/immutability` is off only in `src/world/**`).
- State: zustand stores in `src/world/state/`; API clients in `src/lib/`.
- Design tokens `nx-*` in `globals.css`; utilities `glass`, `glass-solid`, `text-gradient`.
- Prettier is **not** used; don't reformat files with it.
- 3D: three 0.186 + R3F 9 + drei 10. Don't use drei `<Html>` (use
  `world/scene/screenAnchors.tsx`). Render on demand (`invalidate()`).
