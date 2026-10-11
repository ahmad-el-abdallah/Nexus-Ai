# Data Center handoff

Last updated: 2026-10-11. This is the short operational handoff for the next agent.
The durable design and completed-stage reports remain in `DATA_CENTER.md`.

## Approval boundary

- The global product is still **Stage 10 of 16**. Stage 11 is not approved.
- The separate Data Center track is **DC-1 through DC-8**.
- DC-1 through DC-7 are committed. DC-7 is the commit
  `Data Center DC-7: version history, project viewer and dashboard`, pushed to `origin`
  on the owner's explicit request.
- DC-7 was committed before its last gates finished: the smoke test and the clean-copy
  check were **not run**, and the full browser rerun was unfinished (see "DC-7
  verification" in `DATA_CENTER.md`). Run `scripts/smoke.sh` and the full Playwright
  suite before building on it.
- **DC-8 is not approved.** Do not begin it without a new, explicit owner approval.
- Never push unless the owner asks for that push.

## What DC-7 implements

- Per-version download and preview (`?version=n`), owner upload of a new version, and
  restore that appends a verified copy; history is never rewritten.
- Files mirrored by `ArtifactRegistrar` are `source_managed`: readable, comparable and
  downloadable, but manual versions and restores are refused (409).
- The provenance relations that mark a file as a source record's output are reserved
  for the registrar (`managed=True` on `VaultService.link_entry`); everyone else gets 422.
- `backend/app/storage/insights.py` (`VaultInsights`) is read-only: bounded line
  comparison, engineering projects and the dashboard. It writes nothing and goes through
  the Vault service's permission and integrity checks.
- Frontend: `VersionHistory` and `DiffView` in the Vault inspector, `/vault/projects`
  (`ProjectsPage`), `/vault/dashboard` (`VaultDashboard`), a shared `VaultTabs` bar and
  two links in the Data Center room panel.

## Things the next agent should know

- An "engineering project" is the existing `App` with its `AppVersion` rows. There is
  still no canonical Project model; it belongs to global Stage 11. Do not add a
  competing project table.
- Each app version's files are separate Vault entries under
  `AI Artifacts/Apps/<app>/Version n/`, so comparing two app versions compares two
  entries, while comparing a file's own history compares two versions of one entry.
  `GET /api/storage/diff` handles both.
- Changes between app versions are computed from the real `AppFile` contents against
  `AppVersion.base_version`, not from Vault checksums, so they are correct even when a
  stored copy is missing.
- The dashboard buckets days by the caller's UTC offset (`utc_offset_minutes`) and
  leaves `artifact_linked` / `entry_updated` out of its short recent-activity list; the
  per-day counts and each file's own history still include them.
- Nothing in DC-7 needed a migration. The single Alembic head is still
  `0013_storage_foundation`.

## Final DC-7 verification

All of this ran on the final DC-7 tree in isolated WSL copies with temporary databases,
storage roots and fake providers. Exact counts are in `DATA_CENTER.md`.

- Backend Ruff, the full backend suite, frontend ESLint, TypeScript, the unit suite and
  the production build pass.
- The full Playwright suite passes except the pre-existing suspended-walk test in
  `employees.spec.ts` (the employee stays `walking` instead of reaching `away` under
  software GL). It is unrelated to the Data Center and remains open.
- Screenshots reviewed: `.artifacts/e2e/digital-vault-dc7-versions.png`,
  `-projects.png`, `-dashboard.png` and the two `-mobile.png` files.
- `git diff --check`, the secret/private-path scan and a clean copy of the staged tree
  (fresh setup, migrations and smoke test) pass.

## Remaining work

None for DC-7. The next step is the owner's decision about DC-8 (backup/recovery,
integrity, permission boundaries, performance and final polish).

Use `/root/nexus-ai-dev` or another isolated WSL copy for Python/backend execution. The
owner's `/root/nexus-ai` data and real NVIDIA credentials are out of scope.
