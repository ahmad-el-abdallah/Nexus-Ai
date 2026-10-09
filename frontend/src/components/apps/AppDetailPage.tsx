"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { Markdown } from "@/components/chat/Markdown";
import { Initials } from "@/components/hq/people";
import { AppShell } from "@/components/org/AppShell";
import { UsageBar } from "@/components/workflows/ui";
import {
  APP_ACTIVE,
  APP_FINISHED,
  type AppDetail,
  type AppEvent,
  type AppFile,
  type AppRun,
  type AppSummary,
  approveApp,
  AREA_TEXT,
  cancelApp,
  deleteApp,
  fetchApp,
  fetchAppFile,
  requestAppChange,
  resumeApp,
} from "@/lib/apps";
import { liveEvents } from "@/lib/events";
import { useEmployeeStore } from "@/world/state/employeeStore";

import { RunPanel } from "./RunPanel";
import { AppStatusChip, CheckChip, Chip, danger, FileStatusChip, primary, textarea } from "./ui";

function Author({ file, size = "size-6" }: { file: AppFile; size?: string }) {
  const employee = useEmployeeStore((s) => s.employees.find((e) => e.id === file.employee_id));
  return (
    <span className="flex min-w-0 items-center gap-2">
      {employee ? <Initials employee={employee} size={size} /> : <span className={`${size} shrink-0 rounded-full bg-white/10`} />}
      <span className="min-w-0 truncate text-xs text-nx-muted">
        <span className="text-nx-text">{file.author_name ?? "Unassigned"}</span>
        {file.author_role ? ` · ${file.author_role}` : ""}
      </span>
    </span>
  );
}

const ACTION_TEXT: Record<AppFile["action"], string | null> = { new: null, modify: "Change", keep: null };

// ------------------------------------------------------------------- design

function DesignReview({ app, onChange }: { app: AppDetail; onChange: (app: AppDetail) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { current } = app;
  const plan = current.plan;
  const toWrite = current.files.filter((f) => f.status === "planned");
  const kept = current.files.length - toWrite.length;
  const deleted = plan?.change?.files.filter((f) => f.action === "delete") ?? [];

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      onChange(await approveApp(app.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass-solid p-5 ring-1 ring-nx-violet/40" aria-labelledby="design-title" data-testid="app-design">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="design-title" className="text-sm font-semibold text-nx-text">
          {plan?.change ? "The planned change" : "The design"} — your approval is needed
        </h2>
        <p className="text-xs text-nx-faint">
          By {current.architect?.name ?? "the architect"}
          {current.architect ? ` (${current.architect.role})` : ""}. Nothing has been written yet.
        </p>
      </div>
      <p className="mt-2 text-sm text-nx-muted">{plan?.change?.summary ?? plan?.summary}</p>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-nx-faint">Built with</dt>
          <dd className="text-nx-text">{current.stack_name ?? current.stack}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-nx-faint">Packages</dt>
          <dd className="text-nx-text">{plan?.packages.length ? plan.packages.join(", ") : "none"}</dd>
        </div>
      </dl>
      <h3 className="mt-4 text-[11px] tracking-wider text-nx-faint uppercase">Who writes what</h3>
      <ul className="mt-2 divide-y divide-nx-line rounded-xl ring-1 ring-nx-line-strong">
        {toWrite.map((f) => (
          <li key={f.path} className="grid grid-cols-1 gap-x-4 gap-y-1 p-3 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_minmax(0,1fr)]" data-testid="design-file" data-area={f.area}>
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-mono text-xs text-nx-text">{f.path}</span>
              <Chip tone="neutral">{AREA_TEXT[f.area]}</Chip>
              {ACTION_TEXT[f.action] && <Chip tone="info">{ACTION_TEXT[f.action]}</Chip>}
            </span>
            <span className="text-xs leading-5 text-nx-muted">{f.instructions ?? f.purpose}</span>
            <Author file={f} />
          </li>
        ))}
      </ul>
      {(kept > 0 || deleted.length > 0) && (
        <p className="mt-2 text-xs text-nx-faint">
          {kept > 0 && `${kept} other file${kept === 1 ? " stays" : "s stay"} as ${kept === 1 ? "it is" : "they are"}.`}
          {deleted.length > 0 && ` Removed: ${deleted.map((f) => f.path).join(", ")}.`}
        </p>
      )}
      {plan?.api && !plan.change && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-nx-indigo hover:text-nx-cyan">How the backend and the frontend talk to each other</summary>
          <pre className="mt-2 rounded-lg bg-black/20 p-3 font-mono leading-5 whitespace-pre-wrap text-nx-muted ring-1 ring-nx-line">{plan.api}</pre>
        </details>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void approve()} disabled={busy} className={primary}>
          {busy ? "Approving…" : `Approve and build (${toWrite.length} file${toWrite.length === 1 ? "" : "s"})`}
        </button>
        {current.estimate && (
          <p className="text-xs text-nx-muted">
            Expected about {current.estimate.typical} more model requests (at most {current.estimate.worst} with retries and fixes; hard limit {current.max_calls}).
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-nx-error">
          {error}
        </p>
      )}
    </section>
  );
}

// -------------------------------------------------------------------- files

function FileRow({ app, file }: { app: AppDetail; file: AppFile }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = app.current.number;
  const readable = file.status === "written" || (file.status === "fixing" && file.size > 0);

  useEffect(() => {
    if (!open || !readable) return;
    let cancelled = false;
    fetchAppFile(app.id, version, file.path)
      .then((f) => !cancelled && setContent(f.content))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
    // `file.size` and `file.revisions`: reload when the file is rewritten.
  }, [open, readable, app.id, version, file.path, file.size, file.revisions]);

  return (
    <li className="p-3" data-testid="app-file" data-path={file.path} data-status={file.status}>
      <div className="grid grid-cols-1 items-center gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]">
        <button type="button" onClick={() => setOpen(!open)} disabled={!readable} aria-expanded={open} className="flex min-w-0 items-center gap-2 text-left disabled:cursor-default">
          <span aria-hidden className="w-3 text-xs text-nx-faint">
            {readable ? (open ? "▾" : "▸") : ""}
          </span>
          <span className="truncate font-mono text-xs text-nx-text">{file.path}</span>
          {file.status === "written" && <span className="shrink-0 text-[11px] text-nx-faint">{file.lines} lines</span>}
        </button>
        <Author file={file} />
        <span className="flex flex-wrap items-center gap-1.5 sm:justify-end">
          {file.revisions > 0 && <Chip tone="info">Rewritten once</Chip>}
          <CheckChip file={file} />
          <FileStatusChip file={file} />
        </span>
      </div>
      {!open && <p className="mt-1 pl-5 text-xs text-nx-faint">{file.purpose}</p>}
      {file.error && <p className="mt-1 pl-5 text-xs text-nx-error">{file.error}</p>}
      {file.check === "failed" && file.check_error && <p className="mt-1 pl-5 font-mono text-xs whitespace-pre-wrap text-nx-error">{file.check_error}</p>}
      {file.check === "skipped" && file.check_error && <p className="mt-1 pl-5 text-xs text-nx-warn">{file.check_error}</p>}
      {file.review_notes && (
        <p className="mt-1 pl-5 text-xs whitespace-pre-wrap text-nx-muted">
          Reviewer: {file.review_notes}
          {file.revisions > 0 && <span className="text-nx-faint"> — sent back to the author, who rewrote the file. The rewrite was not reviewed again.</span>}
        </p>
      )}
      {open && readable && (
        <div className="mt-2 pl-5">
          <p className="text-xs text-nx-faint">{file.purpose}</p>
          {error && <p className="mt-1 text-xs text-nx-error">{error}</p>}
          <pre className="mt-2 max-h-[32rem] overflow-auto rounded-lg bg-nx-bg/80 p-3 font-mono text-xs leading-5 text-nx-text ring-1 ring-nx-line" data-testid="app-file-content">
            {content ?? "Loading…"}
          </pre>
        </div>
      )}
    </li>
  );
}

// ----------------------------------------------------------------- timeline

// Plain symbols (no emoji), so they look the same wherever NEXUS is opened.
const EVENT_ICON: Record<string, string> = {
  created: "✦",
  change_requested: "✦",
  designed: "◆",
  approved: "✔",
  written: "+",
  fixed: "↺",
  fix_failed: "!",
  file_failed: "✕",
  checked: "✓",
  reviewed: "◉",
  review_skipped: "!",
  delivery_note_missing: "!",
  retry: "↻",
  paused: "‖",
  resumed: "▶",
  cancelled: "✕",
  failed: "✕",
  ready: "★",
};
const BAD_EVENTS = ["failed", "file_failed", "cancelled", "fix_failed", "review_skipped", "delivery_note_missing"];

function Timeline({ events, versions }: { events: AppEvent[]; versions: number }) {
  return (
    <section className="glass-solid p-5" aria-labelledby="app-timeline-title">
      <h2 id="app-timeline-title" className="text-sm font-semibold text-nx-text">
        Timeline
      </h2>
      <ol className="mt-3 space-y-2" data-testid="app-timeline">
        {events.map((e) => (
          <li key={e.id} className="flex gap-3 text-xs" data-kind={e.kind}>
            <span className="w-20 shrink-0 font-mono text-[10px] whitespace-nowrap text-nx-faint">{new Date(e.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <span aria-hidden className={`w-4 shrink-0 text-center ${BAD_EVENTS.includes(e.kind) ? "text-nx-error" : "text-nx-muted"}`}>
              {EVENT_ICON[e.kind] ?? "·"}
            </span>
            <span className="min-w-0 text-nx-text">
              {versions > 1 && <span className="mr-1 text-nx-faint">v{e.version}</span>}
              {e.text}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// --------------------------------------------------------------------- page

const RELOAD_ON: AppSummary["status"][] = ["awaiting_approval", "ready", "failed", "paused", "cancelled"];

export function AppDetailPage({ id }: { id: string }) {
  const router = useRouter();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  const [change, setChange] = useState("");
  /** What the page shows, for the live-event handlers. `selected`: the pinned version; null follows the newest. */
  const shown = useRef<{ selected: number | null; newest: number | null; run: string | null }>({ selected: null, newest: null, run: null });

  const load = useCallback(
    async (version: number | null) => {
      try {
        const next = await fetchApp(id, version ?? undefined);
        shown.current = { selected: version, newest: next.version, run: next.run?.status ?? null };
        setApp(next);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [id],
  );

  useEffect(() => {
    const first = setTimeout(() => void load(null), 0);
    const release = liveEvents.retain();
    const off = [
      liveEvents.on("app.updated", (data) => {
        const s = data as AppSummary;
        if (s.id !== id) return;
        const newVersion = shown.current.newest !== null && s.version !== shown.current.newest;
        setApp((cur) => (cur ? { ...cur, ...s, current: cur.current.number === s.version ? { ...cur.current, status: s.status, status_reason: s.status_reason, calls_used: s.calls_used } : cur.current } : cur));
        // The design, the estimate, the delivery note and the known problems come with the full record.
        if (newVersion || RELOAD_ON.includes(s.status)) void load(newVersion ? null : shown.current.selected);
      }),
      liveEvents.on("app.file", (data) => {
        const f = data as AppFile & { app_id: string; version: number };
        if (f.app_id !== id) return;
        setApp((cur) => (cur && cur.current.number === f.version ? { ...cur, current: { ...cur.current, files: cur.current.files.map((x) => (x.id === f.id ? { ...x, ...f } : x)) } } : cur));
      }),
      liveEvents.on("app.event", (data) => {
        const e = data as AppEvent;
        if (e.app_id !== id) return;
        setApp((cur) => (cur && !cur.events.some((x) => x.id === e.id) ? { ...cur, events: [...cur.events, e] } : cur));
      }),
      liveEvents.on("app.run", (data) => {
        const run = data as AppRun;
        if (run.app_id === id) setApp((cur) => (cur && (!cur.run || cur.run.id === run.id || (cur.run.approved_at ?? "") <= (run.approved_at ?? "")) ? { ...cur, run } : cur));
        // Which app is running (here or elsewhere) is part of the full record.
        if (run.app_id !== id || run.status !== shown.current.run) {
          if (run.app_id === id) shown.current.run = run.status;
          void load(shown.current.selected);
        }
      }),
      liveEvents.on("app.deleted", (data) => (data as { id: string }).id === id && setGone(true)),
      liveEvents.onStatus((_s, reconnected) => reconnected && void load(shown.current.selected)),
    ];
    return () => {
      clearTimeout(first);
      off.forEach((f) => f());
      release();
    };
  }, [id, load]);

  const show = (next: AppDetail, version: number | null = null) => {
    shown.current = { selected: version, newest: next.version, run: next.run?.status ?? null };
    setApp(next);
  };

  const act = async (fn: () => Promise<AppDetail>, confirm?: string) => {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    setError(null);
    try {
      show(await fn());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm("Delete this app? Every version, its installed packages and the data it stored are removed. This can't be undone.")) return;
    setBusy(true);
    try {
      await deleteApp(id);
      router.push("/apps");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const choose = (version: number) => {
    void load(app && version === app.version ? null : version);
  };

  const submitChange = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const next = await requestAppChange(id, change);
      setChange("");
      return next;
    });
  };

  if (gone || !app) {
    return (
      <AppShell title="App">
        {gone ? (
          <p className="text-sm text-nx-muted">This app was deleted.</p>
        ) : error ? (
          <p role="alert" className="text-sm text-nx-error">
            {error}
          </p>
        ) : (
          <p className="text-sm text-nx-muted">Loading…</p>
        )}
        <Link href="/apps" className="text-sm text-nx-indigo hover:text-nx-cyan">
          ← All apps
        </Link>
      </AppShell>
    );
  }

  const { current } = app;
  const newest = current.number === app.version;
  const active = APP_ACTIVE.includes(app.status) || app.status === "awaiting_approval";
  const written = current.files.filter((f) => f.status === "written").length;
  const canChange = APP_FINISHED.includes(app.status) && app.ready_version !== null;
  const working = current.files.filter((f) => f.status === "writing" || f.status === "fixing");

  return (
    <AppShell
      title={app.name}
      subtitle={
        <>
          <Link href="/apps" className="text-nx-indigo hover:text-nx-cyan">
            Apps
          </Link>{" "}
          · built by the engineering team
          {app.source_conversation_id && (
            <>
              {" "}
              ·{" "}
              <Link href={`/chat?c=${app.source_conversation_id}`} className="text-nx-indigo hover:text-nx-cyan">
                from chat
              </Link>
            </>
          )}
        </>
      }
      actions={
        <div className="flex flex-wrap gap-2">
          {(app.status === "paused" || app.status === "failed") && (
            <button type="button" disabled={busy} onClick={() => void act(() => resumeApp(id))} className={primary}>
              {app.status === "failed" ? "Retry" : "Resume"}
            </button>
          )}
          {(active || app.status === "paused") && (
            <button type="button" disabled={busy} onClick={() => void act(() => cancelApp(id), "Cancel this build? Work in progress stops; files already written are kept.")} className={danger}>
              Cancel build
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void remove()} className={danger}>
            Delete app
          </button>
        </div>
      }
    >
      <section className="glass-solid flex flex-wrap items-center gap-x-6 gap-y-3 p-4" aria-label="Status">
        <AppStatusChip status={current.status} />
        <span className="text-xs text-nx-muted">
          {current.files.length ? `${written}/${current.files.length} files written` : "No files yet"}
        </span>
        <UsageBar used={current.calls_used} max={current.max_calls} of="version" />
        <span className="font-mono text-[11px] text-nx-faint">
          {current.prompt_tokens.toLocaleString()} in / {current.completion_tokens.toLocaleString()} out tokens
        </span>
        {app.versions.length > 1 && (
          <span className="flex items-center gap-1" role="group" aria-label="Version">
            {app.versions.map((v) => (
              <button
                key={v.number}
                type="button"
                onClick={() => choose(v.number)}
                aria-pressed={v.number === current.number}
                className={`rounded-lg px-2 py-1 text-xs ring-1 ${v.number === current.number ? "bg-white/10 text-white ring-nx-line-strong" : "text-nx-muted ring-nx-line hover:text-nx-text"}`}
              >
                Version {v.number}
              </button>
            ))}
          </span>
        )}
        {current.status_reason && (
          <p className="w-full text-sm text-nx-warn" data-testid="app-status-reason">
            {current.status_reason}
          </p>
        )}
        {!newest && <p className="w-full text-xs text-nx-faint">You are looking at an earlier version. Version {app.version} is the newest.</p>}
      </section>

      <section className="glass-solid p-5" aria-label="Request">
        <p className="text-[11px] tracking-wider text-nx-faint uppercase">{current.base_version ? `Change requested (to version ${current.base_version})` : "What you asked for"}</p>
        <p className="mt-1 text-sm whitespace-pre-wrap text-nx-text" dir="auto">
          {current.request}
        </p>
        {current.status === "planning" && (
          <p className="mt-3 text-sm text-nx-cyan">
            {current.architect?.name ?? "The architect"} is {current.base_version ? "planning the change" : "designing the app"}…
          </p>
        )}
        {working.length > 0 && (
          <p className="mt-3 text-sm text-nx-cyan" data-testid="app-working">
            {working.map((f) => `${f.author_name ?? "An engineer"} is ${f.status === "fixing" ? "rewriting" : "writing"} ${f.path}`).join(" · ")}… You can watch the code on their monitor in the office.
          </p>
        )}
      </section>

      {error && (
        <p role="alert" className="text-sm text-nx-error">
          {error}
        </p>
      )}

      {newest && current.status === "awaiting_approval" && <DesignReview app={app} onChange={show} />}

      {current.summary && (
        <section className="glass-solid p-5 ring-1 ring-nx-ok/30" aria-labelledby="delivery-title" data-testid="app-delivery">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="delivery-title" className="text-sm font-semibold text-nx-text">
              Delivery note
            </h2>
            <p className="text-xs text-nx-faint">Model-generated. The files were checked for syntax and reviewed by reading — not run or tested.</p>
          </div>
          <div className="mt-3">
            <Markdown text={current.summary} />
          </div>
        </section>
      )}

      {current.known_issues.length > 0 && (
        <section className="glass-solid p-5 ring-1 ring-nx-warn/40" aria-labelledby="issues-title" data-testid="app-issues">
          <h2 id="issues-title" className="text-sm font-semibold text-nx-text">
            Known problems
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 font-mono text-xs whitespace-pre-wrap text-nx-warn">
            {current.known_issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </section>
      )}

      {current.status === "ready" && <RunPanel app={app} onRun={(run) => setApp((cur) => (cur ? { ...cur, run } : cur))} onAskFix={setChange} />}

      {current.files.length > 0 && current.status !== "awaiting_approval" && (
        <section className="glass-solid p-5" aria-labelledby="files-title">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="files-title" className="text-sm font-semibold text-nx-text">
              Files
            </h2>
            <p className="text-xs text-nx-faint">
              {current.stack_name ?? current.stack} · each file by the engineer whose role fits it · open one to read it
            </p>
          </div>
          <ul className="mt-3 divide-y divide-nx-line rounded-xl ring-1 ring-nx-line-strong" aria-label="Files of this version">
            {current.files.map((f) => (
              <FileRow key={f.id} app={app} file={f} />
            ))}
          </ul>
        </section>
      )}

      {canChange && newest && (
        <form onSubmit={submitChange} className="glass-solid space-y-3 p-5" aria-labelledby="change-title" data-testid="app-change">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="change-title" className="text-sm font-semibold text-nx-text">
              Ask for a change
            </h2>
            <p className="text-xs text-nx-faint">The architect plans which files change; you approve; the result is version {app.version + 1}.</p>
          </div>
          <textarea dir="auto" value={change} onChange={(e) => setChange(e.target.value)} rows={3} maxLength={8000} placeholder="Add a search box above the list." aria-label="The change you want" className={textarea} />
          <button type="submit" disabled={busy || change.trim().length < 5} className={primary}>
            {busy ? "Sending…" : "Ask for this change"}
          </button>
        </form>
      )}

      <Timeline events={app.events} versions={app.versions.length} />
    </AppShell>
  );
}
