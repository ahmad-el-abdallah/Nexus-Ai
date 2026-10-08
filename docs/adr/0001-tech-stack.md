# ADR 0001 — Technology stack and foundational decisions

- **Status:** Accepted (Stage 1)
- **Date:** 2026-10-08

## Context

NEXUS AI combines a 3D office, a multi-agent backend, provider integrations (NVIDIA
inference, email, speech) and strict security rules. Several constraints apply:
- It must run locally with no mandatory paid services.
- It must stay maintainable across 16 incremental stages.
- The development machine has an integrated Intel GPU and 7.5 GB RAM.

## Decisions

| Area | Choice | Why |
| --- | --- | --- |
| Frontend framework | **Next.js 16** (App Router, Turbopack), React 19, TypeScript 5.9 | Suggested stack. The server-side proxy keeps the backend address and config out of the browser. TypeScript is pinned to 5.9: TypeScript 7 (the native port) is new and the Next 16 toolchain targets 5.x |
| Styling | **Tailwind CSS 4** with design tokens in `@theme` | Fast iteration on a consistent dark glass design system |
| 3D | **three.js + React Three Fiber + drei** (installed in Stage 2) | Declarative scene graph that fits React state, a large ecosystem and instancing support |
| Backend | **Python 3.12 + FastAPI** (async) | Best ecosystem for AI orchestration, typed request models and native async for streaming |
| Packaging | **uv** with a lockfile; **npm** with `package-lock.json` | Reproducible installs; uv also manages the Python version |
| ORM / migrations | **SQLAlchemy 2.1 async + Alembic** | Portable across SQLite and PostgreSQL; batch mode for SQLite ALTERs |
| Database | **SQLite (WAL)** now; PostgreSQL supported via `NEXUS_DATABASE_URL` | Zero setup. The owner chose SQLite for development; production can use Postgres without code changes |
| Logging | **structlog** with a redaction processor | Structured JSON for machines, readable console for humans, secrets masked centrally |
| Config | **pydantic-settings**, secrets as `SecretStr` | Typed config; secrets can't leak through repr or serialization |
| Frontend ↔ backend | Same-origin REST via Next `rewrites`; live updates as Server-Sent Events through the same proxy (Stage 6) | No CORS and no backend URL in the bundle. SSE is plain HTTP, so it passes through the rewrite unchanged; updates only flow server → client |
| Speech (Stage 7) | **faster-whisper** (STT) + **Piper** (TTS), local, models installed on request | Free and private: audio never leaves the machine; English + Arabic; fast enough on this CPU (Whisper base 1–2.5 s per message). Browser speech APIs rejected because Chrome uploads audio to Google |
| Tests | pytest + httpx ASGI; Vitest + Testing Library; bash smoke test | Fast, hermetic unit and integration tests, plus a real two-server boot check |

## Deferred decisions

- **Orchestration engine (Stage 8).** The choice is between LangGraph and a custom
  state machine persisted in the database.
  - The current lean is the **custom persisted state machine**:
    - Task state must survive restarts.
    - It must drive the 3D office through events.
    - It must enforce budgets and approvals in our own code.
    - It avoids a heavy dependency.
  - LangGraph will be re-evaluated against these requirements at Stage 8.
- **Embeddings and vector search (Stage 13).** Options are SQLite with a vector
  extension, PostgreSQL with pgvector, or keyword-only retrieval when no embedding model
  is configured.
- **Realtime transport (decided in Stage 6): SSE.** One `EventSource` per tab on
  `/api/events` through the Next.js proxy, with a 15 s heartbeat. Client actions stay on
  REST. A WebSocket would need a direct connection to FastAPI plus origin and token
  checks, and nothing needs client → server streaming yet. Revisit if voice (Stage 7)
  needs bidirectional audio streaming.

## Consequences

- Two runtimes (Node and Python) are needed locally. `make setup` hides this.
- The proxy target is fixed in production builds, so changing it requires a rebuild.
  This is documented.
- Moving to PostgreSQL later needs only a URL change and `make migrate`. Data migration
  from an existing SQLite database would need an export/import step.
