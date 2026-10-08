"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { relativeTime } from "@/components/hq/people";
import { Markdown } from "@/components/chat/Markdown";
import { fetchTasks, runTask, type Task, updateTask } from "@/lib/chat";
import { liveEvents } from "@/lib/events";
import { createWorkflow } from "@/lib/workflows";

import { TaskStatusChip } from "../workflows/ui";
import { useEmployeeStore } from "@/world/state/employeeStore";

/**
 * A department's tasks: those from workflows (live status) and those the owner gave
 * the department (done by the assignee or the director right away, or kept open to
 * hand to the CEO as a workflow).
 */
export function TaskBoard({ department }: { department: string }) {
  const employees = useEmployeeStore((s) => s.employees);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [openResult, setOpenResult] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      setTasks(await fetchTasks({ department }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [department]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const release = liveEvents.retain();
    const off = liveEvents.on("task.updated", (data) => {
      const task = data as Task;
      if (task.department !== department) return;
      setTasks((list) => (list ? (list.some((t) => t.id === task.id) ? list.map((t) => (t.id === task.id ? task : t)) : [task, ...list]) : list));
    });
    const offStatus = liveEvents.onStatus((_s, reconnected) => reconnected && void load());
    return () => {
      clearTimeout(first);
      off();
      offStatus();
      release();
    };
  }, [department, load]);

  const setStatus = async (task: Task, status: Task["status"]) => {
    try {
      const updated = await updateTask(task.id, { status });
      setTasks((list) => list?.map((t) => (t.id === updated.id ? updated : t)) ?? null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const start = async (task: Task) => {
    try {
      const updated = await runTask(task.id);
      setTasks((list) => list?.map((t) => (t.id === updated.id ? updated : t)) ?? null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const recorded = tasks?.filter((t) => t.kind === "manual") ?? [];
  // Active: being worked on, waiting, failed, or done in the last day; the rest is history.
  const recent = (t: Task) => t.finished_at && now - new Date(t.finished_at).getTime() < 86_400_000;
  const open = recorded.filter((t) => ["open", "running", "failed"].includes(t.status) || (t.status === "done" && recent(t)));
  const closed = recorded.filter((t) => !open.includes(t));
  const flow = (tasks ?? []).filter((t) => t.kind !== "manual");
  const handToCeo = async (task: Task) => {
    try {
      const workflow = await createWorkflow({ source_task_id: task.id });
      router.push(`/workflows/${workflow.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const nameOf = (id: string | null) => (id ? (employees.find((e) => e.id === id)?.name ?? "Former employee") : "Unassigned");

  const row = (t: Task) => (
    <li key={t.id} className="rounded-xl bg-white/[0.02] p-3 ring-1 ring-nx-line" data-testid="task">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={`text-sm ${t.status === "cancelled" ? "text-nx-faint line-through" : "text-nx-text"}`}>
            {t.kind === "assignment" && <span className="mr-1.5 text-[10px] font-semibold tracking-wider text-nx-cyan uppercase">Assignment</span>}
            {t.title}
          </p>
          <p className="mt-0.5 text-xs text-nx-faint">
            {nameOf(t.assignee_id)} · created {relativeTime(t.created_at)}
            {t.source_conversation_id && (
              <>
                {" · "}
                <Link href={`/chat?c=${t.source_conversation_id}${t.source_message_id ? `&m=${t.source_message_id}` : ""}`} className="text-nx-indigo hover:text-nx-cyan">
                  from chat
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {t.kind !== "manual" ? (
            <>
              <TaskStatusChip status={t.status} />
              {t.workflow_id && (
                <Link href={`/workflows/${t.workflow_id}`} className="text-[11px] text-nx-indigo hover:text-nx-cyan">
                  workflow →
                </Link>
              )}
            </>
          ) : t.status === "running" ? (
            <>
              <TaskStatusChip status="running" />
              <button type="button" onClick={() => void setStatus(t, "cancelled")} className="rounded-lg px-2 py-0.5 text-[11px] text-nx-muted ring-1 ring-nx-line-strong hover:text-nx-error">
                Cancel
              </button>
            </>
          ) : t.status === "failed" ? (
            <>
              <TaskStatusChip status="failed" />
              <button type="button" onClick={() => void start(t)} className="rounded-lg bg-nx-violet/20 px-2 py-0.5 text-[11px] text-nx-text ring-1 ring-nx-violet/50 hover:bg-nx-violet/30">
                Run again
              </button>
            </>
          ) : t.status === "open" ? (
            <>
              <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-nx-muted ring-1 ring-nx-line-strong">Open · not started</span>
              <button
                type="button"
                onClick={() => void start(t)}
                title="The assignee — or the department director — does it now"
                className="rounded-lg bg-nx-cyan/15 px-2 py-0.5 text-[11px] text-nx-text ring-1 ring-nx-cyan/50 hover:bg-nx-cyan/25"
              >
                Start now
              </button>
              <button
                type="button"
                onClick={() => void handToCeo(t)}
                title="The CEO plans it as a workflow; you approve the plan before anything runs"
                className="rounded-lg bg-nx-violet/20 px-2 py-0.5 text-[11px] text-nx-text ring-1 ring-nx-violet/50 hover:bg-nx-violet/30"
              >
                Hand to CEO
              </button>
              <button type="button" onClick={() => void setStatus(t, "cancelled")} className="rounded-lg px-2 py-0.5 text-[11px] text-nx-muted ring-1 ring-nx-line-strong hover:text-nx-error">
                Cancel
              </button>
            </>
          ) : t.status === "done" ? (
            <TaskStatusChip status="done" />
          ) : (
            <button type="button" onClick={() => void start(t)} className="rounded-lg px-2 py-0.5 text-[11px] text-nx-muted ring-1 ring-nx-line-strong hover:text-nx-text">
              Run again
            </button>
          )}
        </div>
      </div>
      {t.description && t.description !== t.title && <p className="mt-2 line-clamp-2 text-xs text-nx-muted">{t.description}</p>}
      {t.kind === "manual" && t.status === "running" && <p className="mt-2 text-xs text-nx-cyan">{nameOf(t.assignee_id)} is working on it — watch their desk monitor in the office.</p>}
      {t.kind === "manual" && t.error && t.status !== "running" && <p className="mt-2 text-xs text-nx-error">{t.error}</p>}
      {t.kind === "manual" && t.result && (
        <div className="mt-2">
          <button type="button" onClick={() => setOpenResult(openResult === t.id ? null : t.id)} className="text-xs text-nx-indigo hover:text-nx-cyan" aria-expanded={openResult === t.id}>
            {openResult === t.id ? "Hide result" : "Show result"}
          </button>
          {openResult === t.id && (
            <div className="mt-2 rounded-lg bg-nx-bg/60 p-3 text-sm ring-1 ring-nx-line" data-testid="task-result">
              <Markdown text={t.result} />
            </div>
          )}
        </div>
      )}
    </li>
  );

  return (
    <div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-nx-error">
          {error}
        </p>
      )}
      {tasks === null && !error && <p className="mt-3 text-sm text-nx-muted">Loading…</p>}
      {tasks && open.length === 0 && flow.length === 0 && <p className="mt-3 text-sm text-nx-muted">No tasks yet. Record one from a chat message, or give the CEO an objective in Workflows.</p>}
      {flow.length > 0 && (
        <>
          <h3 className="mt-4 text-[11px] font-medium tracking-wider text-nx-faint uppercase">From workflows</h3>
          <ul className="mt-2 space-y-2">{flow.slice(0, showAll ? undefined : 8).map(row)}</ul>
          {flow.length > 8 && (
            <button type="button" onClick={() => setShowAll(!showAll)} className="mt-2 text-xs text-nx-faint hover:text-nx-muted">
              {showAll ? "Show fewer" : `Show all ${flow.length}`}
            </button>
          )}
        </>
      )}
      {open.length > 0 && (
        <>
          <h3 className="mt-4 text-[11px] font-medium tracking-wider text-nx-faint uppercase">Tasks you gave</h3>
          <ul className="mt-2 space-y-2">{open.map(row)}</ul>
        </>
      )}
      {closed.length > 0 && (
        <div className="mt-3">
          <button type="button" onClick={() => setShowCancelled(!showCancelled)} className="text-xs text-nx-faint hover:text-nx-muted" aria-expanded={showCancelled}>
            {showCancelled ? "Hide" : "Show"} {closed.length} earlier task{closed.length === 1 ? "" : "s"}
          </button>
          {showCancelled && <ul className="mt-2 space-y-2">{closed.map(row)}</ul>}
        </div>
      )}
    </div>
  );
}
