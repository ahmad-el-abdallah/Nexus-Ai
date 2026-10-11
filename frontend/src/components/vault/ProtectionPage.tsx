"use client";

import { useEffect, useState } from "react";

import { AppShell } from "@/components/org/AppShell";
import {
  checkIntegrity,
  cleanupStorage,
  createBackup,
  fetchBackups,
  fetchDeletedFiles,
  fetchGrants,
  fetchIntegrity,
  recoverFile,
  repairFromBackup,
  revokeGrant,
  verifyBackup,
  type BackupSnapshot,
  type BackupStatus,
  type DeletedFile,
  type IntegrityReport,
  type StorageGrantDetail,
} from "@/lib/storage";

import { bytes, when, workspaceLabel } from "./format";
import { VaultTabs } from "./VaultTabs";

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const BUTTON = "rounded-lg px-3 py-2 text-xs text-nx-text ring-1 ring-nx-line hover:bg-white/5 disabled:opacity-40";

function Tile({ label, value, note, warn }: { label: string; value: string; note: string; warn?: boolean }) {
  return (
    <div className="glass p-4" data-testid="protection-tile" data-label={label}>
      <p className="text-[10px] tracking-[0.16em] text-nx-faint uppercase">{label}</p>
      <p className={`mt-2 text-xl font-semibold tracking-tight ${warn ? "text-nx-warn" : "text-nx-text"}`}>{value}</p>
      <p className="mt-1 text-[11px] leading-4 text-nx-muted">{note}</p>
    </div>
  );
}

function snapshotState(snapshot: BackupSnapshot): { label: string; tone: string } {
  if (snapshot.status === "unreadable") return { label: "Unreadable", tone: "bg-nx-error/15 text-nx-error" };
  if (snapshot.status === "partial") return { label: `Partial — ${plural(snapshot.skipped_versions, "version")} not saved`, tone: "bg-nx-warn/15 text-nx-warn" };
  return { label: "Complete", tone: "bg-nx-ok/15 text-nx-ok" };
}

function verification(snapshot: BackupSnapshot): string {
  if (!snapshot.verified_at) return "Not verified yet";
  return `${snapshot.verified_ok ? "Verified" : "Failed verification"} ${when(snapshot.verified_at)}`;
}

/** Files a backup holds that are no longer in the Vault, each recoverable as a new file. */
function DeletedFiles({ snapshot, busy, onRecover }: { snapshot: BackupSnapshot; busy: boolean; onRecover: (file: DeletedFile) => void }) {
  const [result, setResult] = useState<{ total: number; items: DeletedFile[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchDeletedFiles(snapshot.id)
      .then((value) => active && setResult(value))
      .catch((caught: Error) => active && setError(caught.message));
    return () => {
      active = false;
    };
  }, [snapshot.id]);

  if (error) return <p role="alert" className="mt-3 text-xs text-nx-error">{error}</p>;
  if (!result) return <p role="status" className="mt-3 text-xs text-nx-muted">Comparing this backup with the Vault…</p>;
  if (result.total === 0) return <p className="mt-3 text-xs text-nx-muted">Every file in this backup still exists in the Vault.</p>;
  return (
    <div className="mt-3">
      <p className="text-xs text-nx-muted">{plural(result.total, "file")} in this backup {result.total === 1 ? "is" : "are"} no longer in the Vault. Recovering adds a new file under “Recovered from backup”; nothing is replaced.</p>
      <ul className="mt-2 divide-y divide-nx-line text-xs">
        {result.items.map((file) => (
          <li key={file.entry_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" data-testid="deleted-file">
            <span className="min-w-0 flex-1 basis-full sm:basis-0">
              <span className="block truncate text-nx-text">{file.name}</span>
              <span className="block truncate font-mono text-[10px] text-nx-faint">{workspaceLabel(file.workspace_id)} · {file.path} · {bytes(file.size_bytes)}</span>
            </span>
            {file.present_at ? (
              <span className="text-[11px] text-nx-ok">In the Vault as {file.present_at}</span>
            ) : file.recoverable ? (
              <button disabled={busy} onClick={() => onRecover(file)} className={BUTTON} aria-label={`Recover ${file.name}`}>Recover</button>
            ) : (
              <span className="text-[11px] text-nx-warn">Content was not saved</span>
            )}
          </li>
        ))}
      </ul>
      {result.total > result.items.length && <p className="mt-2 text-[11px] text-nx-faint">Showing the first {result.items.length}.</p>}
    </div>
  );
}

/** Backups, integrity and sharing of the Vault. Every figure is read from the backend. */
export function ProtectionPage() {
  const [backups, setBackups] = useState<BackupStatus | null>(null);
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null);
  const [grants, setGrants] = useState<StorageGrantDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    void Promise.all([fetchBackups(), fetchIntegrity(), fetchGrants()])
      .then(([backupStatus, report, shared]) => {
        if (!active) return;
        setBackups(backupStatus);
        setIntegrity(report);
        setGrants(shared);
      })
      .catch((caught: Error) => active && setError(caught.message));
    return () => {
      active = false;
    };
  }, [revision]);

  const run = (label: string, action: () => Promise<string>) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    void action()
      .then(setNotice)
      .catch((caught: Error) => setError(caught.message))
      .finally(() => {
        setBusy(null);
        setConfirmCleanup(false);
        setRevision((value) => value + 1);
      });
  };

  const backUp = () => run("Backing up…", async () => {
    const snapshot = await createBackup();
    const saved = snapshot.versions - snapshot.skipped_versions;
    return `Backup ${snapshot.status === "complete" ? "complete" : "partial"}: ${saved} of ${plural(snapshot.versions, "version")} saved.`;
  });
  const verify = (snapshot: BackupSnapshot) => run("Verifying backup…", async () => {
    const result = await verifyBackup(snapshot.id);
    if (result.healthy) return `Backup verified: all ${plural(result.checked, "stored object")} match their checksums.`;
    return `Backup failed verification: ${result.missing} missing, ${result.corrupt} corrupt${result.manifest_ok ? "" : "; its manifest is unreadable"}.`;
  });
  const check = () => run("Checking integrity…", async () => {
    const result = await checkIntegrity();
    return `Checked ${plural(result.checked, "version")}: ${result.missing} missing, ${result.corrupt} corrupt, ${plural(result.orphaned, "unused object")}.`;
  });
  const repair = () => run("Repairing from backup…", async () => {
    const result = await repairFromBackup();
    if (result.examined === 0) return "Nothing needed repair: every stored version is intact.";
    return `Repaired ${result.repaired} of ${plural(result.examined, "damaged version")}${result.not_in_backup ? `; ${result.not_in_backup} ${result.not_in_backup === 1 ? "is" : "are"} not in any backup` : ""}${result.failed ? `; ${result.failed} could not be restored` : ""}.`;
  });
  const cleanup = () => run("Removing unused objects…", async () => {
    const result = await cleanupStorage();
    return `Removed ${plural(result.removed_objects, "unused object")} (${bytes(result.removed_bytes)}) and ${plural(result.removed_temporary, "upload fragment")}; ${result.kept_recent} written in the last hour ${result.kept_recent === 1 ? "was" : "were"} left alone.`;
  });
  const recover = (snapshot: BackupSnapshot, file: DeletedFile) => run("Recovering file…", async () => {
    const entry = await recoverFile(snapshot.id, file.entry_id);
    return `Recovered ${file.name} to “${entry.path}” in ${workspaceLabel(entry.workspace_id)}.`;
  });
  const revoke = (grant: StorageGrantDetail) => run("Revoking access…", async () => {
    await revokeGrant(grant.id);
    return `${grant.grantee_name ?? grant.grantee_id} no longer has access to ${grant.entry_name ?? `the ${workspaceLabel(grant.workspace_id)} workspace`}.`;
  });

  const last = integrity?.last_check ?? null;
  // The check is a moment in time; repairs and deletions since then change what is damaged now.
  const settled = last && integrity ? Math.max(0, last.missing + last.corrupt - integrity.damaged_total) : 0;

  return (
    <AppShell
      title="Digital Vault"
      subtitle="Backups you can verify, integrity checks against the stored bytes, and everything that is shared outside its own department."
      actions={<button onClick={() => setRevision((value) => value + 1)} className="rounded-xl px-4 py-2 text-sm text-nx-muted ring-1 ring-nx-line hover:bg-white/5 hover:text-nx-text">Refresh</button>}
    >
      <VaultTabs />
      {error && <p role="alert" className="rounded-xl bg-nx-error/10 px-4 py-3 text-sm text-nx-error ring-1 ring-nx-error/30">{error}</p>}
      {notice && <p role="status" data-testid="protection-notice" className="rounded-xl bg-nx-cyan/10 px-4 py-3 text-sm text-nx-text ring-1 ring-nx-cyan/30">{notice}</p>}
      {busy && <p role="status" className="text-xs text-nx-cyan">{busy}</p>}
      {!backups || !integrity || !grants ? (
        !error && <p role="status" className="glass p-8 text-center text-sm text-nx-muted">Reading backup and integrity state…</p>
      ) : (
        <>
          <section aria-label="Protection summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Last backup" value={!backups.configured ? "Not configured" : backups.last_backup_at ? when(backups.last_backup_at) : "Never"} note={backups.configured ? `${plural(backups.snapshots.length, "backup")} kept; the newest ${backups.keep} are retained` : "No backup folder is set"} warn={!backups.configured || !backups.last_backup_at} />
            <Tile label="Integrity check" value={last ? when(last.at) : "Never"} note={last ? `${plural(last.checked, "version")} compared with stored bytes` : "Stored files have not been checked yet"} warn={!last} />
            <Tile label="Damaged versions" value={String(integrity.damaged_total)} note="Missing or failing their checksum" warn={integrity.damaged_total > 0} />
            <Tile label="Sharing grants" value={String(grants.length)} note="Access given outside the owning department" />
          </section>

          <section className="glass p-4" aria-label="Backups">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-medium text-nx-text">Backups</h2>
              <button disabled={!backups.configured || busy !== null} onClick={backUp} className="rounded-lg bg-nx-violet px-3 py-2 text-xs font-medium text-white disabled:opacity-40">Back up now</button>
            </div>
            {!backups.configured ? (
              <p className="mt-3 text-sm leading-6 text-nx-muted" data-testid="backup-unconfigured">Backups are off. Set <code className="rounded bg-white/5 px-1 font-mono text-xs text-nx-text">NEXUS_STORAGE_BACKUP_ROOT</code> in <code className="rounded bg-white/5 px-1 font-mono text-xs text-nx-text">backend/.env</code> to a folder outside the Vault&apos;s storage folder — ideally on another drive — and restart NEXUS. Until then nothing here claims to protect your files.</p>
            ) : (
              <>
                <p className="mt-2 text-xs leading-5 text-nx-muted">A backup copies every stored version, checks each copy against its checksum and writes a manifest of the Vault&apos;s folders and files. Unchanged files are stored once across backups. It covers Vault files only — not chats, tasks or settings.</p>
                {backups.same_device && <p className="mt-2 rounded-lg bg-nx-warn/10 px-3 py-2 text-xs text-nx-warn ring-1 ring-nx-warn/25" data-testid="backup-same-drive">⚠ The backup folder is on the same drive as the Vault. This protects against deleted and corrupted files, not against losing the drive.</p>}
                {backups.snapshots.length === 0 ? (
                  <p className="mt-4 text-sm text-nx-muted">No backup has been taken yet.</p>
                ) : (
                  <ul className="mt-3 divide-y divide-nx-line">
                    {backups.snapshots.map((snapshot) => {
                      const state = snapshotState(snapshot);
                      return (
                        <li key={snapshot.id} className="py-3" data-testid="backup-snapshot">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
                            <span className="min-w-0 flex-1 basis-full sm:basis-0">
                              <span className="block text-sm text-nx-text">{snapshot.created_at ? when(snapshot.created_at) : "Unknown time"}</span>
                              <span className="mt-0.5 block text-[11px] text-nx-muted">{plural(snapshot.files, "file")} · {plural(snapshot.versions, "version")} · {bytes(snapshot.bytes)} · {verification(snapshot)}</span>
                            </span>
                            <span className={`rounded px-1.5 py-0.5 text-[10px] ${state.tone}`}>{state.label}</span>
                            {snapshot.verified_at && <span className={`rounded px-1.5 py-0.5 text-[10px] ${snapshot.verified_ok ? "bg-nx-ok/15 text-nx-ok" : "bg-nx-error/15 text-nx-error"}`}>{snapshot.verified_ok ? "Verified" : "Failed verification"}</span>}
                            <button disabled={busy !== null} onClick={() => verify(snapshot)} className={BUTTON}>Verify</button>
                            <button disabled={snapshot.status === "unreadable"} aria-expanded={expanded === snapshot.id} onClick={() => setExpanded((current) => (current === snapshot.id ? null : snapshot.id))} className={BUTTON}>Deleted files</button>
                          </div>
                          {expanded === snapshot.id && <DeletedFiles key={`${snapshot.id}:${revision}`} snapshot={snapshot} busy={busy !== null} onRecover={(file) => recover(snapshot, file)} />}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </section>

          <section className="glass p-4" aria-label="Integrity">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-medium text-nx-text">Integrity</h2>
              <div className="flex flex-wrap gap-2">
                <button disabled={busy !== null} onClick={check} className={BUTTON}>Check integrity now</button>
                <button disabled={busy !== null || !backups.configured || integrity.damaged_total === 0} onClick={repair} className={BUTTON}>Repair from backup</button>
                <button disabled={busy !== null || !last || last.orphaned === 0} onClick={() => (confirmCleanup ? cleanup() : setConfirmCleanup(true))} className={`${BUTTON} ${confirmCleanup ? "text-nx-error ring-nx-error/40" : ""}`}>{confirmCleanup ? "Confirm: remove unused objects" : "Remove unused objects"}</button>
              </div>
            </div>
            <p className="mt-2 text-xs leading-5 text-nx-muted" data-testid="integrity-last-check">
              {last ? `Last check ${when(last.at)}: ${plural(last.checked, "version")} compared with stored bytes — ${last.missing} missing, ${last.corrupt} corrupt, ${plural(last.orphaned, "stored object")} that no file refers to.${settled ? ` ${settled} damaged ${settled === 1 ? "version has" : "versions have"} since been repaired or removed.` : ""}` : "No integrity check has been run yet. A check re-reads every stored version and compares it with its recorded size and checksum."}
            </p>
            {confirmCleanup && <p className="mt-2 text-xs text-nx-warn">Unused objects are removed permanently. Anything written in the last hour is left alone, because an upload may still be finishing.</p>}
            {integrity.damaged_total === 0 ? (
              <p className="mt-4 text-sm text-nx-muted">No damaged versions are known.</p>
            ) : (
              <>
                <ul className="mt-3 divide-y divide-nx-line text-xs">
                  {integrity.damaged.map((item) => (
                    <li key={`${item.entry_id}:${item.version}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" data-testid="damaged-version">
                      <span className="min-w-0 flex-1 basis-full sm:basis-0">
                        <span className="block truncate text-nx-text">{item.name} <span className="text-nx-faint">· version {item.version}{item.is_current ? " (current)" : ""}</span></span>
                        <span className="block truncate font-mono text-[10px] text-nx-faint">{workspaceLabel(item.workspace_id)} · {item.path} · {bytes(item.size_bytes)}</span>
                      </span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${item.status === "missing" ? "bg-nx-error/15 text-nx-error" : "bg-nx-warn/15 text-nx-warn"}`}>{item.status === "missing" ? "Missing" : "Corrupt"}</span>
                    </li>
                  ))}
                </ul>
                {integrity.damaged_total > integrity.damaged.length && <p className="mt-2 text-[11px] text-nx-faint">Showing the first {integrity.damaged.length} of {integrity.damaged_total}.</p>}
              </>
            )}
          </section>

          <section className="glass p-4" aria-label="Sharing">
            <h2 className="text-sm font-medium text-nx-text">Sharing</h2>
            <p className="mt-2 text-xs leading-5 text-nx-muted">A department&apos;s workspace is readable only by that department&apos;s employees. These are the exceptions you have granted; share an item from its details in Files.</p>
            {grants.length === 0 ? (
              <p className="mt-4 text-sm text-nx-muted">Nothing is shared outside its own department.</p>
            ) : (
              <ul className="mt-3 divide-y divide-nx-line text-xs">
                {grants.map((grant) => (
                  <li key={grant.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" data-testid="sharing-grant">
                    <span className="min-w-0 flex-1 basis-full sm:basis-0">
                      <span className="block truncate text-nx-text">{grant.entry_name ?? "Whole workspace"} <span className="text-nx-faint">→ {grant.grantee_name ?? grant.grantee_id} ({grant.grantee_kind})</span></span>
                      <span className="block truncate text-[10px] text-nx-faint">{workspaceLabel(grant.workspace_id)}{grant.entry_path ? ` · ${grant.entry_path}` : ""} · {grant.permission === "read" ? "can read" : grant.permission === "write" ? "can read and change" : "can manage"} · {grant.expires_at ? `until ${when(grant.expires_at)}` : "no expiry"}</span>
                    </span>
                    <button disabled={busy !== null} onClick={() => revoke(grant)} className={BUTTON} aria-label={`Revoke access of ${grant.grantee_name ?? grant.grantee_id}`}>Revoke</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </AppShell>
  );
}
