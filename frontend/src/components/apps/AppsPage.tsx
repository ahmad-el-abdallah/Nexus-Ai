"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import { relativeTime } from "@/components/hq/people";
import { AppShell } from "@/components/org/AppShell";
import { UsageBar } from "@/components/workflows/ui";
import { type AppSummary, createApp, fetchApps } from "@/lib/apps";
import { liveEvents } from "@/lib/events";

import { AppStatusChip, primary, textarea } from "./ui";

const EXAMPLE = "A to-do list for my team: add tasks, mark them done, and filter by who they belong to.";

function NewApp() {
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const app = await createApp({ description });
      router.push(`/apps/${app.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="glass-solid space-y-3 p-5" aria-labelledby="new-app-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="new-app-title" className="text-sm font-semibold text-nx-text">
          Ask engineering for a web app
        </h2>
        <p className="text-xs text-nx-faint">The architect drafts a design; nothing is written until you approve it.</p>
      </div>
      <textarea
        dir="auto"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
        maxLength={8000}
        placeholder={EXAMPLE}
        aria-label="What the app should do"
        className={textarea}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy || description.trim().length < 10} className={primary}>
          {busy ? "Sending to engineering…" : "Ask for a design"}
        </button>
        {!description && (
          <button type="button" onClick={() => setDescription(EXAMPLE)} className="text-xs text-nx-indigo hover:text-nx-cyan">
            Use the example
          </button>
        )}
        <p className="text-xs text-nx-faint">The design uses one model request. Each file is then written by the engineer whose role fits it.</p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-nx-error">
          {error}
        </p>
      )}
    </form>
  );
}

function Row({ app }: { app: AppSummary }) {
  return (
    <li>
      <Link href={`/apps/${app.id}`} className="glass-solid flex flex-col gap-2 p-4 transition hover:ring-1 hover:ring-nx-violet/40 sm:flex-row sm:items-center sm:gap-4" data-testid="app-row">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-nx-text">{app.name}</p>
          <p className="mt-0.5 truncate text-xs text-nx-faint">
            Version {app.version}
            {app.ready_version && app.ready_version !== app.version ? ` (version ${app.ready_version} is ready)` : ""} · asked {app.created_at ? relativeTime(app.created_at) : "—"}
          </p>
        </div>
        <span className="text-xs text-nx-muted">
          {app.files.total ? `${app.files.written}/${app.files.total} files written` : "No files yet"}
        </span>
        <UsageBar used={app.calls_used} max={app.max_calls} of="version" />
        <AppStatusChip status={app.status} />
      </Link>
    </li>
  );
}

export function AppsPage() {
  const [apps, setApps] = useState<AppSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setApps(await fetchApps());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const release = liveEvents.retain();
    const off = [
      liveEvents.on("app.updated", (data) => {
        const app = data as AppSummary;
        setApps((list) => (list ? (list.some((x) => x.id === app.id) ? list.map((x) => (x.id === app.id ? app : x)) : [app, ...list]) : list));
      }),
      liveEvents.on("app.deleted", (data) => {
        const { id } = data as { id: string };
        setApps((list) => list?.filter((x) => x.id !== id) ?? list);
      }),
      liveEvents.onStatus((_s, reconnected) => reconnected && void load()),
    ];
    return () => {
      clearTimeout(first);
      off.forEach((f) => f());
      release();
    };
  }, [load]);

  return (
    <AppShell
      title="Apps"
      subtitle="Ask the engineering team for a web application. The architect designs it, you approve the design, each engineer writes the files of their role, the result is checked and reviewed — then you can download it, run it here in the sandbox, or ask for changes."
    >
      <NewApp />
      {error && (
        <p role="alert" className="text-sm text-nx-error">
          Couldn&apos;t load apps ({error}).
        </p>
      )}
      {apps === null && !error && <p className="text-sm text-nx-muted">Loading…</p>}
      {apps?.length === 0 && <p className="text-sm text-nx-muted">No apps yet.</p>}
      <ul className="space-y-2" aria-label="Apps">
        {apps?.map((app) => (
          <Row key={app.id} app={app} />
        ))}
      </ul>
    </AppShell>
  );
}
