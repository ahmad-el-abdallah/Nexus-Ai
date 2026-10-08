# Testing

## Never spend real credits in tests
- Backend unit tests use `httpx.MockTransport` fakes (`tests/test_ai.py` FakeProvider,
  `tests/test_workflows.py` AgentProvider). Workflow prompts carry a format tag
  (`Format: NEXUS-PLAN/1`, …) and `tests/fake_agents.py` returns valid canned replies.
- E2E uses `backend/tests/fake_provider.py` (port 18300, key
  `fake-e2e-key-0123456789abcdef`, models `fake/fast`, `fake/locked` (404), `fake/other`).
- Voice: `NEXUS_VOICE_FAKE=1` (allowed only with `NEXUS_ENV=test`) plus Chrome's fake
  microphone. Opt-in real round trip: `NEXUS_TEST_VOICE_MODELS=<dir> pytest -k real`.

## Layout
- Backend: pytest + httpx ASGITransport, hermetic settings (ignore `.env`), a temp
  migrated SQLite DB per test; `test_migrations.py` checks model/migration drift;
  `test_repo_hygiene.py` scans for secrets and non-`example.com` emails.
- Frontend: Vitest + Testing Library (jsdom has no canvas/WebGL/MediaRecorder — test pure
  logic; mock `next/navigation` when components use the router).
- E2E: Playwright with system Chrome (`channel: chrome`, GPU flags), production build in
  `.next-e2e`, isolated backend on 18200 with `/tmp/nexus-e2e-18200.db`. Projects:
  desktop, mobile, no-webgl. Test hooks: `window.__NEXUS_OFFICE__`, `window.__NEXUS_PERF__`.

## Writing good tests
- Assert real counts from the API, not fixed numbers that depend on earlier specs
  (other specs hire employees).
- Next keeps the previous route mounted (hidden) after navigation — scope selectors to the
  visible page (e.g. `getByRole("region", { name: "Status" })`).
- Wait on state, not sleeps; run flaky suspects several times in a row before trusting them.
