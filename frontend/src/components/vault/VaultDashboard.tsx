"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AppShell } from "@/components/org/AppShell";
import { fetchDashboard, type StorageDashboard } from "@/lib/storage";

import { bytes, when, workspaceLabel } from "./format";
import { VaultTabs } from "./VaultTabs";

const CREATOR_LABEL = { owner: "Uploaded by you", employee: "Produced by employees", system: "Registered by the system" } as const;

function typeLabel(value: string | null): string {
  if (!value) return "Unclassified";
  return value.replaceAll("-", " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

function share(used: number, quota: number): string {
  if (!quota) return "no quota";
  const percent = (used / quota) * 100;
  if (percent === 0) return "0%";
  return percent < 0.1 ? "under 0.1%" : `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
}

function day(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function Tile({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "warn" }) {
  return (
    <div className="glass p-4" data-testid="dashboard-tile" data-label={label}>
      <p className="text-[10px] tracking-[0.16em] text-nx-faint uppercase">{label}</p>
      <p className={`mt-2 text-2xl font-semibold tracking-tight ${tone === "warn" ? "text-nx-warn" : "text-nx-text"}`}>{value}</p>
      {note && <p className="mt-1 text-[11px] leading-4 text-nx-muted">{note}</p>}
    </div>
  );
}

/** Events per calendar day. One series, so the heading names it; days with errors say so in words. */
function Activity({ days }: { days: StorageDashboard["activity"] }) {
  const peak = Math.max(...days.map((item) => item.events));
  const total = days.reduce((sum, item) => sum + item.events, 0);
  const withErrors = days.filter((item) => item.errors > 0);
  if (total === 0) return <p className="mt-4 text-sm text-nx-muted">Not enough data — no storage activity was recorded in the last {days.length} days.</p>;
  return (
    <div className="mt-4">
      <div className="flex h-32 items-end gap-0.5 border-b border-nx-line" role="img" aria-label={`Storage events per day for the last ${days.length} days: ${total} in total, at most ${peak} in one day.`}>
        {days.map((item) => (
          <div key={item.date} tabIndex={0} className="group relative flex h-full flex-1 items-end outline-none" data-testid="activity-day">
            <div className="w-full rounded-t bg-nx-cyan/70 transition group-hover:bg-nx-cyan group-focus:bg-nx-cyan" style={{ height: `${(item.events / peak) * 100}%` }} />
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-md bg-nx-bg-raised px-2 py-1 text-[10px] whitespace-nowrap text-nx-text ring-1 ring-nx-line-strong group-hover:block group-focus:block">
              {day(item.date)}: {item.events} event{item.events === 1 ? "" : "s"}{item.errors ? `, ${item.errors} error${item.errors === 1 ? "" : "s"}` : ""}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-nx-faint"><span>{day(days[0]!.date)}</span><span>busiest day: {peak} event{peak === 1 ? "" : "s"}</span><span>{day(days.at(-1)!.date)}</span></div>
      {withErrors.length > 0 && <p className="mt-2 text-[11px] text-nx-warn">⚠ Errors were recorded on {withErrors.map((item) => `${day(item.date)} (${item.errors})`).join(", ")}.</p>}
      <table className="sr-only">
        <caption>Storage events per day</caption>
        <thead><tr><th>Day</th><th>Events</th><th>Errors</th></tr></thead>
        <tbody>{days.map((item) => <tr key={item.date}><td>{item.date}</td><td>{item.events}</td><td>{item.errors}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

/** Real storage totals, usage, composition and recent activity. Nothing here is estimated. */
export function VaultDashboard() {
  const [board, setBoard] = useState<StorageDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    void fetchDashboard()
      .then((value) => {
        if (active) {
          setBoard(value);
          setError(null);
        }
      })
      .catch((caught: Error) => active && setError(caught.message));
    return () => {
      active = false;
    };
  }, [revision]);

  const used = board?.workspaces.filter((workspace) => workspace.file_count > 0 || workspace.used_bytes > 0).sort((a, b) => b.used_bytes - a.used_bytes) ?? [];
  const empty = (board?.workspaces.length ?? 0) - used.length;
  const mostFiles = Math.max(1, ...(board?.by_type.map((row) => row.files) ?? []));

  return (
    <AppShell
      title="Digital Vault"
      subtitle="What the Vault really holds: totals, usage per workspace, what the files are and what happened recently."
      actions={<button onClick={() => setRevision((value) => value + 1)} className="rounded-xl px-4 py-2 text-sm text-nx-muted ring-1 ring-nx-line hover:bg-white/5 hover:text-nx-text">Refresh</button>}
    >
      <VaultTabs />
      {error && <p role="alert" className="rounded-xl bg-nx-error/10 px-4 py-3 text-sm text-nx-error ring-1 ring-nx-error/30">Dashboard unavailable: {error}</p>}
      {!board ? (
        !error && <p role="status" className="glass p-8 text-center text-sm text-nx-muted">Reading storage totals…</p>
      ) : (
        <>
          <section aria-label="Totals" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Tile label="Stored" value={bytes(board.totals.stored_bytes)} note="All versions, including history and Trash" />
            <Tile label="Files" value={String(board.totals.files)} note={`${board.totals.folders} folder${board.totals.folders === 1 ? "" : "s"}`} />
            <Tile label="Versions" value={String(board.totals.versions)} note="Kept unchanged once written" />
            <Tile label="In Trash" value={String(board.totals.trashed)} note="Files and folders" />
            <Tile label="Unavailable files" value={String(board.totals.unavailable_files)} note="Missing or failed validation" tone={board.totals.unavailable_files ? "warn" : undefined} />
            <Tile label="Failed registrations" value={String(board.totals.registration_failures)} note="Claimed outputs that were not stored" tone={board.totals.registration_failures ? "warn" : undefined} />
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="glass p-4" aria-label="Storage by workspace">
              <h2 className="text-sm font-medium text-nx-text">Storage by workspace</h2>
              {used.length === 0 ? (
                <p className="mt-4 text-sm text-nx-muted">Not enough data — no workspace holds a file yet.</p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {used.map((workspace) => (
                    <li key={workspace.id} data-testid="dashboard-workspace">
                      <div className="flex items-baseline justify-between gap-3 text-xs">
                        <span className="truncate text-nx-text">{workspace.name}{workspace.state === "read_only" && <span className="ml-2 rounded bg-nx-warn/15 px-1.5 text-[10px] text-nx-warn">read-only</span>}</span>
                        <span className="shrink-0 font-mono text-[11px] text-nx-muted">{bytes(workspace.used_bytes)} of {bytes(workspace.quota_bytes)} · {share(workspace.used_bytes, workspace.quota_bytes)}</span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10" role="meter" aria-label={`${workspace.name} quota used`} aria-valuemin={0} aria-valuemax={workspace.quota_bytes} aria-valuenow={workspace.used_bytes}>
                        <div className={`h-full rounded-full ${workspace.quota_bytes && workspace.used_bytes / workspace.quota_bytes > 0.85 ? "bg-nx-warn" : "bg-nx-cyan"}`} style={{ width: `${workspace.quota_bytes ? Math.min(100, (workspace.used_bytes / workspace.quota_bytes) * 100) : 0}%` }} />
                      </div>
                      <p className="mt-1 text-[10px] text-nx-faint">{workspace.file_count} file{workspace.file_count === 1 ? "" : "s"}</p>
                    </li>
                  ))}
                </ul>
              )}
              {empty > 0 && <p className="mt-3 text-[11px] text-nx-faint">{empty} other workspace{empty === 1 ? " holds" : "s hold"} no files.</p>}
            </section>

            <section className="glass p-4" aria-label="Stored files by type">
              <h2 className="text-sm font-medium text-nx-text">Files by type</h2>
              {board.by_type.length === 0 ? (
                <p className="mt-4 text-sm text-nx-muted">Not enough data — nothing is stored yet.</p>
              ) : (
                <ul className="mt-3 space-y-2.5">
                  {board.by_type.map((row) => (
                    <li key={row.artifact_type ?? "unclassified"} data-testid="dashboard-type" title={`${typeLabel(row.artifact_type)}: ${row.files} files, ${bytes(row.bytes)}`}>
                      <div className="flex items-baseline justify-between gap-3 text-xs"><span className="text-nx-text">{typeLabel(row.artifact_type)}</span><span className="font-mono text-[11px] text-nx-muted">{row.files} file{row.files === 1 ? "" : "s"} · {bytes(row.bytes)}</span></div>
                      <div className="mt-1 h-1.5"><div className="h-full rounded-r bg-nx-cyan/70" style={{ width: `${(row.files / mostFiles) * 100}%` }} /></div>
                    </li>
                  ))}
                </ul>
              )}
              {board.by_creator.length > 0 && (
                <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-nx-line pt-3 text-xs">
                  {board.by_creator.map((row) => <div key={row.kind}><dt className="text-[10px] leading-4 text-nx-faint">{CREATOR_LABEL[row.kind]}</dt><dd className="mt-0.5 text-nx-text">{row.files}</dd></div>)}
                </dl>
              )}
            </section>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="glass p-4" aria-label="Storage activity">
              <h2 className="text-sm font-medium text-nx-text">Storage events per day <span className="text-[11px] font-normal text-nx-faint">· last {board.activity.length} days, your local time</span></h2>
              <Activity days={board.activity} />
            </section>

            <section className="glass p-4" aria-label="Employees and projects">
              <h2 className="text-sm font-medium text-nx-text">Employees with the most stored files</h2>
              {board.top_creators.length === 0 ? (
                <p className="mt-4 text-sm text-nx-muted">Not enough data — no employee work has been stored yet.</p>
              ) : (
                <ol className="mt-3 space-y-1.5 text-xs">
                  {board.top_creators.map((creator) => (
                    <li key={creator.employee_id} className="flex items-center justify-between gap-3">
                      <Link href={`/employees/${creator.employee_id}`} className="truncate text-nx-text hover:underline">{creator.name ?? "Unnamed employee"}</Link>
                      <span className="font-mono text-[11px] text-nx-muted">{creator.files} file{creator.files === 1 ? "" : "s"}</span>
                    </li>
                  ))}
                </ol>
              )}
              {board.projects && (
                <div className="mt-4 border-t border-nx-line pt-3">
                  <h3 className="text-xs font-medium text-nx-text">Engineering projects</h3>
                  <p className="mt-1 text-xs text-nx-muted" data-testid="dashboard-projects">{board.projects.apps} app{board.projects.apps === 1 ? "" : "s"} · {board.projects.ready_versions} finished version{board.projects.ready_versions === 1 ? "" : "s"} · {board.projects.stored_files} stored source file{board.projects.stored_files === 1 ? "" : "s"}</p>
                  <Link href="/vault/projects" className="mt-2 inline-block text-xs text-nx-cyan hover:underline">Open engineering projects →</Link>
                </div>
              )}
            </section>
          </div>

          <section className="glass p-4" aria-label="Recent storage activity">
            <h2 className="text-sm font-medium text-nx-text">Recent activity <span className="text-[11px] font-normal text-nx-faint">· link and metadata updates are in each file&apos;s own history</span></h2>
            {board.recent_events.length === 0 ? (
              <p className="mt-4 text-sm text-nx-muted">No storage activity has been recorded yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-nx-line text-xs">
                {board.recent_events.map((event) => (
                  <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2" data-testid="dashboard-event">
                    {event.level !== "info" && <span className={`rounded px-1.5 text-[10px] ${event.level === "error" ? "bg-nx-error/15 text-nx-error" : "bg-nx-warn/15 text-nx-warn"}`}>{event.level === "error" ? "Error" : "Warning"}</span>}
                    <span className="min-w-0 flex-1 basis-full text-nx-muted sm:basis-0">{event.text}</span>
                    <span className="text-[10px] text-nx-faint">{event.actor_name ?? "System"} · {workspaceLabel(event.workspace_id)} · {when(event.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p className="text-[11px] text-nx-faint">Read from the backend at {when(board.generated_at)}. {board.totals.error_events} error event{board.totals.error_events === 1 ? "" : "s"} recorded in total.</p>
        </>
      )}
    </AppShell>
  );
}
