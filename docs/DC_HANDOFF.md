# Data Center handoff

Last updated: 2026-10-11. This is the short operational handoff for the next agent.
The durable design and completed-stage reports remain in `DATA_CENTER.md`.

## Approval boundary

- The global product is still **Stage 10 of 16**. Stage 11 is not approved.
- The separate Data Center track **DC-1 through DC-8 is complete**. There is no DC-9;
  further Data Center work needs a new, explicit request from the owner.
- DC-1 to DC-8 are on `main` and pushed. DC-8 is one commit,
  `Data Center DC-8: backup, recovery, integrity and sharing`. It was built on the
  branch `data-center-dc8` and merged at the owner's request; that branch is deleted.
- The owner works on `main` together with someone else: start new stage-sized work on
  its own branch, and merge or push only when the owner asks.

## What DC-8 implements

- `backend/app/storage/backup.py` — `VaultBackup` and `BackupStore`: snapshots into
  `NEXUS_STORAGE_BACKUP_ROOT` (content-addressed objects plus one checksummed manifest
  per snapshot), verification, repair of missing or corrupt versions, recovery of a
  permanently deleted file as a new file, and retention (`NEXUS_STORAGE_BACKUP_KEEP`).
- `VaultService`: batched `reconcile`, `integrity`, confirmed `cleanup` with a one-hour
  grace period, `active_grants`, `search(shared=True)`, batched `entry_views`.
- Frontend: `/vault/protection` (`ProtectionPage`), `SharePanel` in the Vault inspector,
  a **Shared** view, and backup/integrity lines in the Data Center room panel.
- Tests: `backend/tests/test_storage_dc8.py`, `frontend/src/components/vault/dc8.test.tsx`,
  `frontend/e2e/vault-dc8.spec.ts`, one more check in `mobile.spec.ts` and new smoke
  checks.

## Things the next agent should know

- The truth about backups is the backup folder, not the database: snapshots are listed
  by reading manifests, and only verification results are stored as `backup_verified`
  events. Nothing in DC-8 needed a migration; the single Alembic head is still
  `0013_storage_foundation`.
- Snapshot ids carry a microsecond timestamp (`bkp_<YYYYMMDDTHHMMSSffffff>Z_<8 hex>`),
  so sorting the names is sorting by time. Retention relies on this.
- `VaultBackup` must stay a single instance per app (`app.state.backup`): its lock is
  what makes backup, verify, repair and recover exclusive.
- Repair repoints a version's `storage_key` to a freshly written object. The old corrupt
  object becomes unreferenced and is removed by `cleanup` once it is an hour old.
- Recovery deliberately creates a new entry. The deleted-files list reports
  `present_at` when identical content already exists in that workspace.
- The browser tests give the backend `/tmp/nexus-e2e-backups-<port>` and empty it before
  each run. `vault-dc8.spec.ts` deletes a stored object from the test storage folder on
  disk to simulate a failing drive.
- A backup does not include the application database. Protecting chats, tasks and
  settings is a separate, unrequested piece of work.

## Verification

Exact counts are under "DC-8 verification" in `DATA_CENTER.md`. The pre-existing
suspended-walk test in `employees.spec.ts` still fails under software GL (the employee
stays `walking` instead of reaching `away`); it is unrelated to the Data Center.

Use `/root/nexus-ai-dev` or another isolated WSL copy for Python/backend execution. The
owner's `/root/nexus-ai` data and real NVIDIA credentials are out of scope.
