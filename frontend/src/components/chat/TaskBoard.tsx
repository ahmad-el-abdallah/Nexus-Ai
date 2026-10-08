"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { relativeTime } from "@/components/hq/people";
import { fetchTasks, type Task, updateTask } from "@/lib/chat";
import { liveEvents } from "@/lib/events";
import { useEmployeeStore } from "@/world/state/employeeStore";

/**
 * A department's recorded tasks. Tasks are created from chat in Stage 6 and
 * stay "open — not started" until the orchestration engine (Stage 8) runs them.
 */
export function TaskBoard({ department }: { department: string }) {
  const employees = useEmployeeStore((s) => s.employees);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);

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

  const open = tasks?.filter((t) => t.status === "open") ?? [];
  const cancelled = tasks?.filter((t) => t.status === "cancelled") ?? [];
  const nameOf = (id: string | null) => (id ? (employees.find((e) => e.id === id)?.name ?? "Former employee") : "Unassigned");

  const row = (t: Task) => (
    <li key={t.id} className="rounded-xl bg-white/[0.02] p-3 ring-1 ring-nx-line" data-testid="task">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={`text-sm ${t.status === "cancelled" ? "text-nx-faint line-through" : "text-nx-text"}`}>{t.title}</p>
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
          {t.status === "open" ? (
            <>
              <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-nx-muted ring-1 ring-nx-line-strong">Open · not started</span>
              <button type="button" onClick={() => void setStatus(t, "cancelled")} className="rounded-lg px-2 py-0.5 text-[11px] text-nx-muted ring-1 ring-nx-line-strong hover:text-nx-error">
                Cancel
              </button>
            </>
          ) : (
            <button type="button" onClick={() => void setStatus(t, "open")} className="rounded-lg px-2 py-0.5 text-[11px] text-nx-muted ring-1 ring-nx-line-strong hover:text-nx-text">
              Reopen
            </button>
          )}
        </div>
      </div>
      {t.description && t.description !== t.title && <p className="mt-2 line-clamp-2 text-xs text-nx-muted">{t.description}</p>}
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
      {tasks && open.length === 0 && <p className="mt-3 text-sm text-nx-muted">No open tasks. Create one from any chat message with “Create task”.</p>}
      <ul className="mt-3 space-y-2">{open.map(row)}</ul>
      {cancelled.length > 0 && (
        <div className="mt-3">
          <button type="button" onClick={() => setShowCancelled(!showCancelled)} className="text-xs text-nx-faint hover:text-nx-muted" aria-expanded={showCancelled}>
            {showCancelled ? "Hide" : "Show"} {cancelled.length} cancelled
          </button>
          {showCancelled && <ul className="mt-2 space-y-2">{cancelled.map(row)}</ul>}
        </div>
      )}
    </div>
  );
}
