"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { input, labelCls, primaryBtn, ghostBtn } from "@/components/settings/ui";
import { createTask, type Task, taskTitleFrom } from "@/lib/chat";
import { useDepartmentStore } from "@/world/state/departmentStore";
import { useEmployeeStore } from "@/world/state/employeeStore";

export interface TaskSource {
  text: string;
  department: string;
  assigneeId: string | null;
  conversationId: string;
  messageId: number;
}

/** Creates a task from a chat message; the assignee (or the director) starts on it at once. */
export function TaskDialog({ source, onClose }: { source: TaskSource; onClose: () => void }) {
  const departments = useDepartmentStore((s) => s.departments);
  const employees = useEmployeeStore((s) => s.employees);
  const [title, setTitle] = useState(() => taskTitleFrom(source.text));
  const [description, setDescription] = useState(source.text);
  const [department, setDepartment] = useState(source.department);
  const [assignee, setAssignee] = useState(source.assigneeId ?? "");
  const [run, setRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Task | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialog.current;
    if (!el || el.open) return;
    if (typeof el.showModal === "function") el.showModal();
    else el.setAttribute("open", ""); // environments without <dialog> support
  }, []);

  const members = employees.filter((e) => e.department === department).sort((a, b) => a.name.localeCompare(b.name));
  const departmentName = departments.find((d) => d.key === department)?.name ?? department;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setCreated(
        await createTask({
          title: title.trim(),
          description,
          department,
          assignee_id: assignee || null,
          source_conversation_id: source.conversationId,
          source_message_id: source.messageId,
          run,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      onCancel={onClose}
      aria-labelledby="task-dialog-title"
      className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-2xl bg-nx-bg-raised p-0 text-nx-text ring-1 ring-nx-line-strong backdrop:bg-black/60"
    >
      {created ? (
        <div className="p-6">
          <h2 id="task-dialog-title" className="text-base font-semibold">
            {created.status === "running" ? "Task started" : "Task recorded"}
          </h2>
          <p className="mt-2 text-sm text-nx-muted" role="status">
            {created.status === "running" ? (
              <>
                <strong className="text-nx-text">{employees.find((e) => e.id === created.assignee_id)?.name ?? "The assignee"}</strong> is working on “{created.title}” now. The
                result will appear in this chat and on {departmentName}&apos;s task board.
              </>
            ) : (
              <>
                “{created.title}” is on {departmentName}&apos;s task board as <strong className="text-nx-text">open — not started</strong>
                {created.error ? ` (${created.error})` : ""}. Start it or hand it to the CEO from there.
              </>
            )}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Link href={`/departments/${created.department}#tasks-title`} className={ghostBtn}>
              Open task board
            </Link>
            <button type="button" onClick={onClose} className={primaryBtn} autoFocus>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4 p-6">
          <div>
            <h2 id="task-dialog-title" className="text-base font-semibold">
              Create a task from this message
            </h2>
            <p className="mt-1 text-xs text-nx-faint">The assignee — or the department director if nobody is chosen — does it right away (one AI request).</p>
          </div>
          <label className={labelCls}>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={160} className={input} autoFocus />
          </label>
          <label className={labelCls}>
            Details
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={6} maxLength={20000} className={`${input} h-auto py-2 leading-5`} />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelCls}>
              Department
              <select
                value={department}
                onChange={(e) => {
                  setDepartment(e.target.value);
                  setAssignee("");
                }}
                className={input}
              >
                {departments.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={labelCls}>
              Assignee
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={input}>
                <option value="">The director decides (does it)</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} — {m.role}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-nx-text">
            <input type="checkbox" checked={run} onChange={(e) => setRun(e.target.checked)} />
            Start working on it now
            <span className="text-xs text-nx-faint">(untick to only record it, e.g. to hand it to the CEO as a workflow)</span>
          </label>
          {error && (
            <p role="alert" className="text-sm text-nx-error">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={ghostBtn}>
              Cancel
            </button>
            <button type="submit" disabled={busy || title.trim().length < 3} className={primaryBtn}>
              {busy ? "Saving…" : run ? "Create and start" : "Create task"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
