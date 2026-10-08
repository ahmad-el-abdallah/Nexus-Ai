"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Markdown } from "@/components/chat/Markdown";
import { Initials } from "@/components/hq/people";
import { AppShell } from "@/components/org/AppShell";
import type { Task } from "@/lib/chat";
import { liveEvents } from "@/lib/events";
import {
  approveWorkflow,
  cancelWorkflow,
  cancelWorkflowTask,
  fetchWorkflow,
  FINISHED,
  resumeWorkflow,
  type WorkflowDetail,
  type WorkflowEvent,
  type WorkflowSummary,
} from "@/lib/workflows";
import { useDepartmentStore } from "@/world/state/departmentStore";
import { useEmployeeStore } from "@/world/state/employeeStore";

import { TaskStatusChip, UsageBar, WorkflowStatusChip } from "./ui";

const btn = "rounded-lg px-3 py-2 text-sm ring-1 disabled:opacity-50";
const primary = `${btn} bg-nx-violet/30 font-semibold text-white ring-nx-violet/60 hover:bg-nx-violet/40`;
const danger = `${btn} text-nx-warn ring-nx-warn/50 hover:bg-nx-warn/10`;

function useNames() {
  const employees = useEmployeeStore((s) => s.employees);
  const departments = useDepartmentStore((s) => s.departments);
  return {
    person: (id: string | null) => employees.find((e) => e.id === id),
    dept: (key: string) => departments.find((d) => d.key === key),
  };
}

function Expandable({ label, children, open = false }: { label: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details className="group mt-2" open={open}>
      <summary className="cursor-pointer list-none text-xs text-nx-indigo hover:text-nx-cyan">
        <span className="group-open:hidden">▸ {label}</span>
        <span className="hidden group-open:inline">▾ {label}</span>
      </summary>
      <div className="mt-2 rounded-lg bg-black/20 p-3 ring-1 ring-nx-line">{children}</div>
    </details>
  );
}

// --------------------------------------------------------------------- plan

function PlanReview({ w, onChange }: { w: WorkflowDetail; onChange: (w: WorkflowDetail) => void }) {
  const { person, dept } = useNames();
  const assignments = w.tasks.filter((t) => t.kind === "assignment");
  const [excluded, setExcluded] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kept = assignments.length - excluded.length;
  const title = (id: string) => assignments.find((a) => a.id === id)?.title ?? id;

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      onChange(await approveWorkflow(w.id, excluded));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass-solid p-5 ring-1 ring-nx-violet/40" aria-labelledby="plan-title" data-testid="plan-review">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="plan-title" className="text-sm font-semibold text-nx-text">
          The CEO&apos;s plan — your approval is needed
        </h2>
        <p className="text-xs text-nx-faint">Only the CEO&apos;s planning has run so far ({w.calls_used} request).</p>
      </div>
      {w.plan && <p className="mt-2 text-sm text-nx-muted">{w.plan.summary}</p>}
      <ul className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {assignments.map((a) => {
          const d = dept(a.department);
          const lead = person(a.assignee_id);
          const off = excluded.includes(a.id);
          return (
            <li key={a.id} className={`rounded-xl p-4 ring-1 transition ${off ? "opacity-50 ring-nx-line" : "bg-white/[0.03] ring-nx-line-strong"}`} data-testid="plan-assignment">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={!off}
                  onChange={() => setExcluded(off ? excluded.filter((x) => x !== a.id) : [...excluded, a.id])}
                  className="mt-1"
                  aria-label={`Include ${d?.name ?? a.department}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="size-2 rounded-full" style={{ background: d?.color ?? "#94a3b8" }} />
                    <span className="text-sm font-medium text-nx-text">{d?.name ?? a.department}</span>
                    <span className="text-xs text-nx-faint">· supervised by {lead?.name ?? "—"}</span>
                  </span>
                  <span className="mt-1 block text-sm text-nx-text">{a.title}</span>
                  <span className="mt-1 block text-xs leading-5 text-nx-muted">{a.description}</span>
                  {a.depends_on.length > 0 && <span className="mt-2 block text-[11px] text-nx-cyan">Starts after: {a.depends_on.map(title).join(", ")}</span>}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void approve()} disabled={busy || kept === 0} className={primary}>
          {busy ? "Approving…" : `Approve and run (${kept} department${kept === 1 ? "" : "s"})`}
        </button>
        {w.estimate && (
          <p className="text-xs text-nx-muted">
            Expected about {w.estimate.typical} more model requests (at most {w.estimate.worst} with retries and revisions; hard limit {w.max_calls}). Departments you untick are skipped.
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

// ----------------------------------------------------------------- progress

function WorkTask({ t, workflowId, active, onChange }: { t: Task; workflowId: string; active: boolean; onChange: (w: WorkflowDetail) => void }) {
  const { person } = useNames();
  const who = person(t.assignee_id);
  const cancellable = active && !["done", "failed", "skipped", "cancelled"].includes(t.status);
  return (
    <li className="rounded-lg bg-black/15 p-3 ring-1 ring-nx-line" data-testid="work-task" data-status={t.status}>
      <div className="flex items-start gap-2">
        {who ? <Initials employee={who} size="size-6" /> : <span className="size-6 rounded-full bg-white/10" />}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-nx-text">{t.title}</p>
          <p className="text-[11px] text-nx-faint">
            {who?.name ?? "Unassigned"}
            {t.revisions ? ` · revised ${t.revisions}×` : ""}
            {t.attempts > 1 ? ` · ${t.attempts} attempts` : ""}
            {t.calls ? ` · ${t.calls} request${t.calls === 1 ? "" : "s"}` : ""}
          </p>
        </div>
        <TaskStatusChip status={t.status} />
      </div>
      {t.error && <p className="mt-2 text-xs text-nx-error">{t.error}</p>}
      {t.review_notes && <p className="mt-2 text-xs text-nx-muted">Supervisor: {t.review_notes}</p>}
      {t.result && (
        <Expandable label="Deliverable">
          <Markdown text={t.result} />
        </Expandable>
      )}
      {cancellable && (
        <button type="button" onClick={() => void cancelWorkflowTask(workflowId, t.id).then(onChange)} className="mt-2 text-[11px] text-nx-faint hover:text-nx-warn">
          Cancel this task
        </button>
      )}
    </li>
  );
}

function Assignment({ a, w, onChange }: { a: Task; w: WorkflowDetail; onChange: (w: WorkflowDetail) => void }) {
  const { person, dept } = useNames();
  const d = dept(a.department);
  const lead = person(a.assignee_id);
  const work = w.tasks.filter((t) => t.parent_id === a.id).sort((x, y) => x.position - y.position);
  const deps = a.depends_on.map((id) => w.tasks.find((t) => t.id === id)).filter(Boolean) as Task[];
  const active = !FINISHED.includes(w.status);
  return (
    <li className="glass-solid overflow-hidden p-0" data-testid="assignment" data-department={a.department} data-status={a.status}>
      <div className="h-1" style={{ background: d?.color ?? "#94a3b8" }} />
      <div className="p-4">
        <div className="flex items-start gap-3">
          {lead ? <Initials employee={lead} size="size-9" /> : <span className="size-9 rounded-full bg-white/10" />}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-nx-text">{d?.name ?? a.department}</p>
            <p className="text-xs text-nx-faint">Supervisor: {lead?.name ?? "—"}</p>
          </div>
          <TaskStatusChip status={a.status} />
        </div>
        <p className="mt-3 text-sm text-nx-text">{a.title}</p>
        <p className="mt-1 text-xs leading-5 text-nx-muted">{a.description}</p>
        {deps.length > 0 && (
          <p className="mt-2 text-[11px] text-nx-cyan">
            Needs: {deps.map((dep) => `${dept(dep.department)?.name ?? dep.department}${dep.status === "done" ? " ✓" : ""}`).join(", ")}
          </p>
        )}
        {a.error && <p className="mt-2 text-xs text-nx-warn">{a.error}</p>}
        {work.length > 0 && (
          <ul className="mt-3 space-y-2" aria-label={`${d?.name ?? a.department} tasks`}>
            {work.map((t) => (
              <WorkTask key={t.id} t={t} workflowId={w.id} active={active} onChange={onChange} />
            ))}
          </ul>
        )}
        {a.status === "planning" && <p className="mt-3 text-xs text-nx-muted">{lead?.name ?? "The supervisor"} is splitting the assignment into tasks…</p>}
        {a.result && (
          <Expandable label="Department result">
            <Markdown text={a.result} />
          </Expandable>
        )}
        {active && !["done", "failed", "skipped", "cancelled"].includes(a.status) && (
          <button type="button" onClick={() => void cancelWorkflowTask(w.id, a.id).then(onChange)} className="mt-3 text-[11px] text-nx-faint hover:text-nx-warn">
            Cancel this department&apos;s assignment
          </button>
        )}
      </div>
    </li>
  );
}

// ----------------------------------------------------------------- timeline

const EVENT_ICON: Record<string, string> = {
  created: "✦",
  plan_proposed: "🗺",
  approved: "✔",
  delegated: "→",
  handoff: "⇄",
  breakdown: "☰",
  assigned: "👤",
  delivered: "📄",
  revision_requested: "↺",
  approved_work: "✓",
  review_failed: "!",
  summary_failed: "!",
  department_done: "■",
  retry: "↻",
  reassigned: "👤",
  failed: "✕",
  skipped: "⤼",
  paused: "⏸",
  resumed: "▶",
  task_cancelled: "✕",
  cancelled: "✕",
  workflow_failed: "✕",
  completed: "★",
};

function Timeline({ events }: { events: WorkflowEvent[] }) {
  const { dept } = useNames();
  return (
    <section className="glass-solid p-5" aria-labelledby="timeline-title">
      <h2 id="timeline-title" className="text-sm font-semibold text-nx-text">
        Timeline
      </h2>
      <ol className="mt-3 space-y-2" data-testid="timeline">
        {events.map((e) => (
          <li key={e.id} className="flex gap-3 text-xs" data-kind={e.kind}>
            <span className="w-14 shrink-0 font-mono text-[10px] text-nx-faint">{new Date(e.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <span aria-hidden className={`w-4 shrink-0 text-center ${["failed", "workflow_failed", "cancelled", "task_cancelled"].includes(e.kind) ? "text-nx-error" : e.kind === "handoff" ? "text-nx-cyan" : "text-nx-muted"}`}>
              {EVENT_ICON[e.kind] ?? "·"}
            </span>
            <span className="min-w-0 text-nx-muted">
              {e.kind === "handoff" && e.from_department && e.to_department && (
                <span className="mr-1 rounded bg-nx-cyan/10 px-1.5 py-0.5 text-[10px] text-nx-cyan">
                  {dept(e.from_department)?.name ?? e.from_department} → {dept(e.to_department)?.name ?? e.to_department}
                </span>
              )}
              <span className="text-nx-text">{e.text}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// --------------------------------------------------------------------- page

export function WorkflowDetailPage({ id }: { id: string }) {
  const [w, setW] = useState<WorkflowDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { person } = useNames();

  const load = useCallback(async () => {
    try {
      setW(await fetchWorkflow(id));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const release = liveEvents.retain();
    const off = [
      liveEvents.on("workflow.updated", (data) => {
        const s = data as WorkflowSummary;
        if (s.id !== id) return;
        setW((cur) => (cur ? { ...cur, ...s } : cur));
        // The plan, estimate and report arrive with the full record.
        if (s.status === "awaiting_approval" || ["completed", "partial", "failed"].includes(s.status)) void load();
      }),
      liveEvents.on("task.updated", (data) => {
        const t = data as Task;
        if (t.workflow_id !== id) return;
        setW((cur) => (cur ? { ...cur, tasks: cur.tasks.some((x) => x.id === t.id) ? cur.tasks.map((x) => (x.id === t.id ? t : x)) : [...cur.tasks, t] } : cur));
      }),
      liveEvents.on("workflow.event", (data) => {
        const e = data as WorkflowEvent;
        if (e.workflow_id !== id) return;
        setW((cur) => (cur && !cur.events.some((x) => x.id === e.id) ? { ...cur, events: [...cur.events, e] } : cur));
      }),
      liveEvents.onStatus((_s, reconnected) => reconnected && void load()),
    ];
    return () => {
      clearTimeout(first);
      off.forEach((f) => f());
      release();
    };
  }, [id, load]);

  const assignments = useMemo(() => (w ? w.tasks.filter((t) => t.kind === "assignment").sort((a, b) => a.position - b.position) : []), [w]);

  const act = async (fn: () => Promise<WorkflowDetail>, confirm?: string) => {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    setError(null);
    try {
      setW(await fn());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!w) {
    return (
      <AppShell title="Workflow">
        {error ? (
          <p role="alert" className="text-sm text-nx-error">
            {error}
          </p>
        ) : (
          <p className="text-sm text-nx-muted">Loading…</p>
        )}
        <Link href="/workflows" className="text-sm text-nx-indigo hover:text-nx-cyan">
          ← All workflows
        </Link>
      </AppShell>
    );
  }

  const ceo = person(w.ceo_id);
  const active = ["planning", "awaiting_approval", "running", "consolidating"].includes(w.status);
  const work = w.tasks.filter((t) => t.kind === "work");
  const shown = assignments.filter((a) => w.approved_at || a.status !== "cancelled");

  return (
    <AppShell
      title={w.title}
      subtitle={
        <>
          <Link href="/workflows" className="text-nx-indigo hover:text-nx-cyan">
            Workflows
          </Link>{" "}
          · Objective from you to {ceo?.name ?? "the CEO"}
          {w.source_conversation_id && (
            <>
              {" "}
              ·{" "}
              <Link href={`/chat?c=${w.source_conversation_id}`} className="text-nx-indigo hover:text-nx-cyan">
                from chat
              </Link>
            </>
          )}
        </>
      }
      actions={
        <div className="flex flex-wrap gap-2">
          {(w.status === "paused" || w.status === "failed") && (
            <button type="button" disabled={busy} onClick={() => void act(() => resumeWorkflow(w.id))} className={primary}>
              {w.status === "failed" ? "Retry" : "Resume"}
            </button>
          )}
          {(active || w.status === "paused") && (
            <button type="button" disabled={busy} onClick={() => void act(() => cancelWorkflow(w.id), "Cancel this workflow? Work in progress stops and nothing further runs.")} className={danger}>
              Cancel workflow
            </button>
          )}
        </div>
      }
    >
      <section className="glass-solid flex flex-wrap items-center gap-x-6 gap-y-3 p-4" aria-label="Status">
        <WorkflowStatusChip status={w.status} />
        <span className="text-xs text-nx-muted">
          {w.assignments.done}/{w.assignments.total - (w.approved_at ? assignments.filter((a) => a.status === "cancelled").length : 0)} departments done · {work.filter((t) => t.status === "done").length}/{work.length} tasks done
        </span>
        <UsageBar used={w.calls_used} max={w.max_calls} />
        <span className="font-mono text-[11px] text-nx-faint">
          {w.prompt_tokens.toLocaleString()} in / {w.completion_tokens.toLocaleString()} out tokens
        </span>
        {w.status_reason && <p className="w-full text-sm text-nx-warn" data-testid="status-reason">{w.status_reason}</p>}
      </section>

      <section className="glass-solid p-5" aria-label="Objective">
        <p className="text-[11px] tracking-wider text-nx-faint uppercase">Objective</p>
        <p className="mt-1 text-sm whitespace-pre-wrap text-nx-text" dir="auto">
          {w.objective}
        </p>
        {w.status === "planning" && <p className="mt-3 text-sm text-nx-cyan">{ceo?.name ?? "The CEO"} is drafting the plan…</p>}
      </section>

      {error && (
        <p role="alert" className="text-sm text-nx-error">
          {error}
        </p>
      )}

      {w.status === "awaiting_approval" && <PlanReview w={w} onChange={setW} />}

      {w.result && (
        <section className="glass-solid p-5 ring-1 ring-nx-ok/30" aria-labelledby="report-title" data-testid="final-report">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="report-title" className="text-sm font-semibold text-nx-text">
              Final report from {ceo?.name ?? "the CEO"}
            </h2>
            <p className="text-xs text-nx-faint">Model-generated from the departments&apos; work — assumptions are marked and need verification.</p>
          </div>
          <div className="mt-3">
            <Markdown text={w.result} />
          </div>
        </section>
      )}

      {w.approved_at && shown.length > 0 && (
        <section aria-labelledby="departments-title">
          <h2 id="departments-title" className="mb-3 text-sm font-semibold text-nx-text">
            Departments
          </h2>
          <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {shown.map((a) => (
              <Assignment key={a.id} a={a} w={w} onChange={setW} />
            ))}
          </ul>
        </section>
      )}

      <Timeline events={w.events} />
    </AppShell>
  );
}
