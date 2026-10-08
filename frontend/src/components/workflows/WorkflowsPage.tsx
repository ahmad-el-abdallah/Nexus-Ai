"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import { relativeTime } from "@/components/hq/people";
import { AppShell } from "@/components/org/AppShell";
import { liveEvents } from "@/lib/events";
import { createWorkflow, fetchWorkflows, type WorkflowSummary } from "@/lib/workflows";
import { useDepartmentStore } from "@/world/state/departmentStore";
import { useEmployeeStore } from "@/world/state/employeeStore";

import { UsageBar, WorkflowStatusChip } from "./ui";

const EXAMPLE = "Research a new software business opportunity and create an implementation plan.";

function NewWorkflow() {
  const router = useRouter();
  const employees = useEmployeeStore((s) => s.employees);
  const executive = useDepartmentStore((s) => s.departments.find((d) => d.key === "executive"));
  const ceo = employees.find((e) => e.id === executive?.director_id);
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const workflow = await createWorkflow({ objective });
      router.push(`/workflows/${workflow.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="glass-solid space-y-3 p-5" aria-labelledby="new-workflow-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="new-workflow-title" className="text-sm font-semibold text-nx-text">
          Give the CEO an objective
        </h2>
        <p className="text-xs text-nx-faint">
          {ceo ? `${ceo.name} drafts a plan; nothing runs until you approve it.` : "The CEO drafts a plan; nothing runs until you approve it."}
        </p>
      </div>
      <textarea
        dir="auto"
        value={objective}
        onChange={(e) => setObjective(e.target.value)}
        rows={3}
        maxLength={8000}
        placeholder={EXAMPLE}
        aria-label="Objective"
        className="w-full resize-y rounded-lg bg-nx-bg/80 px-3 py-2 text-sm leading-6 text-nx-text ring-1 ring-nx-line-strong placeholder:text-nx-faint focus:ring-nx-violet/60 focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy || objective.trim().length < 10}
          className="rounded-lg bg-nx-violet/30 px-4 py-2 text-sm font-semibold text-white ring-1 ring-nx-violet/60 hover:bg-nx-violet/40 disabled:opacity-50"
        >
          {busy ? "Sending to the CEO…" : "Ask the CEO to plan it"}
        </button>
        {!objective && (
          <button type="button" onClick={() => setObjective(EXAMPLE)} className="text-xs text-nx-indigo hover:text-nx-cyan">
            Use the example
          </button>
        )}
        <p className="text-xs text-nx-faint">Planning uses one model request. Agents produce text only — no browsing, email or spending.</p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-nx-error">
          {error}
        </p>
      )}
    </form>
  );
}

function Row({ w }: { w: WorkflowSummary }) {
  const departments = useDepartmentStore((s) => s.departments);
  const names = w.departments.map((k) => departments.find((d) => d.key === k)?.name ?? k);
  const work = Object.values(w.work).reduce((a, b) => a + (b ?? 0), 0);
  return (
    <li>
      <Link href={`/workflows/${w.id}`} className="glass-solid flex flex-col gap-2 p-4 transition hover:ring-1 hover:ring-nx-violet/40 sm:flex-row sm:items-center sm:gap-4" data-testid="workflow-row">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-nx-text">{w.title}</p>
          <p className="mt-0.5 truncate text-xs text-nx-faint">
            {names.length ? names.join(" · ") : "Plan being drafted"} · started {w.created_at ? relativeTime(w.created_at) : "—"}
          </p>
        </div>
        <span className="text-xs text-nx-muted">
          {w.assignments.done}/{w.assignments.total} departments · {w.work.done ?? 0}/{work} tasks
        </span>
        <UsageBar used={w.calls_used} max={w.max_calls} />
        <WorkflowStatusChip status={w.status} />
      </Link>
    </li>
  );
}

export function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setWorkflows(await fetchWorkflows());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const release = liveEvents.retain();
    const off = [
      liveEvents.on("workflow.updated", (data) => {
        const w = data as WorkflowSummary;
        setWorkflows((list) => (list ? (list.some((x) => x.id === w.id) ? list.map((x) => (x.id === w.id ? w : x)) : [w, ...list]) : list));
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
      title="Workflows"
      subtitle="Give the CEO an objective. The CEO plans which departments do what; you approve the plan; supervisors split the work, workers deliver, supervisors review, and the CEO consolidates the result."
    >
      <NewWorkflow />
      {error && (
        <p role="alert" className="text-sm text-nx-error">
          Couldn&apos;t load workflows ({error}).
        </p>
      )}
      {workflows === null && !error && <p className="text-sm text-nx-muted">Loading…</p>}
      {workflows?.length === 0 && <p className="text-sm text-nx-muted">No workflows yet.</p>}
      <ul className="space-y-2" aria-label="Workflows">
        {workflows?.map((w) => (
          <Row key={w.id} w={w} />
        ))}
      </ul>
    </AppShell>
  );
}
