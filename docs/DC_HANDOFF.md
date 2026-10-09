# Data Center handoff

Last updated: 2026-10-10. This is the short operational handoff for the next agent.
The durable design and completed-stage reports remain in `DATA_CENTER.md`.

## Approval boundary

- The global product is still **Stage 10 of 16**. Stage 11 is not approved.
- The separate Data Center track is **DC-1 through DC-8**.
- DC-1 through DC-6 are committed and complete. DC-6 is the local commit
  `Data Center DC-6: register real employee artifacts`.
- **DC-7 is not approved.** Do not begin it without a new, explicit owner approval.
- Never push.

## What DC-6 implements

- `ArtifactRegistrar` automatically registers real persisted artifacts from completed
  tasks, completed workflows, ready engineering app files, real code-run outputs, and
  chat attachments.
- Registration uses the existing Vault permission/quota service, opaque blob keys,
  immutable versions, normalized metadata/tags and validated provenance links.
- Re-registering unchanged bytes is idempotent; changed task/source bytes append a new
  immutable version.
- Missing or unsafe recorded run files create an error audit event and no fake file.
- Startup recovery backfills eligible existing source records.
- Controlled employee methods cover save, list, read, update, create-folder, search and
  link while deriving the writable workspace from the employee's real department.
- `/vault` has an **AI generated** view backed by the `ai-generated` tag. Its inspector
  shows real previews, creator metadata, versions and expanded provenance.
- A discovered app-builder race is fixed: a new change request queues behind a previous
  ready build that is still completing artifact registration.
- Repeated chat attachment names remain distinct by including their stable source ID.

## Important source mapping

| Source | Destination | Provenance |
| --- | --- | --- |
| Task result | Department / `AI Artifacts/Tasks` | task |
| Workflow report | Company / `AI Artifacts/Workflows` | workflow and source task |
| App file | Engineering / `AI Artifacts/Apps/.../Version n` | app, version and app file |
| Code-run output | Producing department / `AI Artifacts/Code Runs/<run>` | run and task/message |
| Chat attachment | Conversation department / `AI Artifacts/Chat Attachments/<conversation>` | message/attachment relation |

There is still no canonical Project model; it belongs to global Stage 11. Do not create
a competing project table or pretend DC-6 added one.

## Final DC-6 verification

All of this ran on the final DC-6 tree in isolated WSL copies with temporary databases,
storage roots and fake providers.

- Backend Ruff check and format check: pass.
- Full backend suite: 266 passed, 4 skipped. This includes the 4 focused DC-6 tests
  (real bytes/provenance, versioning, idempotency, missing-file audit behavior,
  controlled employee methods and repeated attachment names).
- Frontend ESLint and TypeScript: pass.
- Frontend unit suite: 189 passed.
- Production build: pass, 22 routes.
- Full Playwright suite under software GL: 56 passed, 1 failed. The failure is the
  pre-existing suspended-walk test in `employees.spec.ts`: the employee stays `walking`
  instead of reaching `away`. Every Data Center, Vault, mobile and no-WebGL test passed.
- Screenshot reviewed at `.artifacts/e2e/digital-vault-dc6-generated.png`.
- `git diff --check`: clean. Secret/private-path scan of the 25 changed files and of the
  `.next` / `.next-e2e` build output: no real key and no private path.
- Clean copy of the staged tree (353 files): fresh `scripts/setup.sh`, all migrations to
  `0013_storage_foundation`, and the smoke test on ports 18080/13000 passed. Only the
  wording of this handoff file changed after that copy was taken.

## Remaining work

None for DC-6. The next step is the owner's decision about DC-7 (engineering project
viewer, immutable versions, restore, diffs and dashboards). The known suspended-walk
browser failure is unrelated to the Data Center and remains open.

## Files intentionally changed for DC-6

- Backend: storage registrar/service, app/chat/task/workflow/run integrations, main
  wiring, storage link schemas, and DC-6/task-runner tests.
- Frontend: Vault generated view/types/tests, DC-6 browser test, live Data Center count
  assertion, and corrected room copy.
- Docs: `README.md`, `CLAUDE.md`, `DATA_CENTER.md`, `DEVELOPMENT.md`, `ARCHITECTURE.md`,
  `STAGES.md`, and this handoff.

Use `/root/nexus-ai-dev` or another isolated WSL copy for Python/backend execution. The
owner's `/root/nexus-ai` data and real NVIDIA credentials are out of scope.
