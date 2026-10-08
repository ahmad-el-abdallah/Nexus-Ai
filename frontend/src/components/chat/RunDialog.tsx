"use client";

import { useEffect, useRef, useState } from "react";

import { ghostBtn, primaryBtn } from "@/components/settings/ui";
import { liveEvents } from "@/lib/events";
import { approveRun, type CodeRun, fetchRun, prepareRun, rejectRun, RUN_STATUS_TEXT, runFileUrl } from "@/lib/runs";

export interface RunRequest {
  code: string;
  language: string;
  messageId?: number | null;
  taskId?: string | null;
}

const LANGUAGE_NAME: Record<string, string> = { python: "Python 3", javascript: "JavaScript (Node.js)", bash: "Bash" };

function size(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Running an employee's code: the server stores the exact code, the owner reads it and
 * approves (or not); then it runs in the sandbox and the output shows here live.
 */
export function RunDialog({ request, onClose }: { request: RunRequest; onClose: () => void }) {
  const [run, setRun] = useState<CodeRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    }
    let cancelled = false;
    prepareRun({ code: request.code, language: request.language, message_id: request.messageId, task_id: request.taskId })
      .then((r) => !cancelled && setRun(r))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [request]);

  useEffect(() => {
    if (!run) return;
    const release = liveEvents.retain();
    const off = liveEvents.on("run.updated", (data) => {
      const updated = data as CodeRun;
      if (updated.id === run.id) setRun(updated);
    });
    // In case an update arrived before we listened.
    const poll = run.status === "running" ? setTimeout(() => void fetchRun(run.id).then(setRun).catch(() => {}), 1500) : undefined;
    return () => {
      off();
      release();
      if (poll) clearTimeout(poll);
    };
  }, [run]);

  const close = () => {
    if (run?.status === "pending_approval") void rejectRun(run.id).catch(() => {});
    onClose();
  };

  const approve = async () => {
    if (!run) return;
    setBusy(true);
    setError(null);
    try {
      setRun(await approveRun(run));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finished = run && !["pending_approval", "running"].includes(run.status);
  const tone = run?.status === "succeeded" ? "text-nx-ok" : run?.status === "running" || run?.status === "pending_approval" ? "text-nx-cyan" : "text-nx-error";

  return (
    <dialog
      ref={dialog}
      onClose={close}
      onCancel={close}
      aria-labelledby="run-dialog-title"
      className="m-auto w-[min(48rem,calc(100vw-2rem))] rounded-2xl bg-nx-bg-raised p-0 text-nx-text ring-1 ring-nx-line-strong backdrop:bg-black/60"
      data-testid="run-dialog"
    >
      <div className="max-h-[85vh] space-y-4 overflow-y-auto p-6">
        <div>
          <h2 id="run-dialog-title" className="text-base font-semibold">
            Run this {LANGUAGE_NAME[run?.language ?? ""] ?? request.language} code?
          </h2>
          <p className="mt-1 text-xs text-nx-faint">
            Written by {run?.author_name ?? "an employee"}. Read it first — it runs only after you approve this exact code.
          </p>
        </div>
        <pre className="max-h-64 overflow-auto rounded-lg bg-nx-bg/80 p-3 font-mono text-xs leading-5 ring-1 ring-nx-line" data-testid="run-code">
          {run?.code ?? request.code}
        </pre>
        <ul className="grid grid-cols-1 gap-1 rounded-lg bg-white/[0.03] p-3 text-xs text-nx-muted ring-1 ring-nx-line sm:grid-cols-2" aria-label="Sandbox rules">
          <li>🔒 No internet access</li>
          <li>🔒 Can&apos;t see your files — only its own empty folder</li>
          <li>⏱ Stopped after 30 seconds</li>
          <li>💾 512 MB memory, 64 processes, 1 CPU core</li>
          <li>📦 Python standard library only (no pip installs)</li>
          <li>⬇️ Files it creates can be downloaded afterwards</li>
        </ul>
        {error && (
          <p role="alert" className="text-sm text-nx-error">
            {error}
          </p>
        )}
        {run && run.status !== "pending_approval" && (
          <section aria-label="Run result" className="space-y-2" data-testid="run-result" data-status={run.status}>
            <p className={`text-sm font-semibold ${tone}`} role="status">
              {RUN_STATUS_TEXT[run.status]}
              {run.exit_code !== null && ` · exit code ${run.exit_code}`}
              {run.duration_ms !== null && ` · ${run.duration_ms < 1000 ? `${run.duration_ms} ms` : `${(run.duration_ms / 1000).toFixed(1)} s`}`}
            </p>
            {run.error && <p className="text-xs text-nx-error">{run.error}</p>}
            {(run.stdout || finished) && (
              <div>
                <p className="text-[11px] tracking-wider text-nx-faint uppercase">Output</p>
                <pre className="mt-1 max-h-72 overflow-auto rounded-lg bg-black/40 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-nx-text" data-testid="run-stdout">
                  {run.stdout || "(no output)"}
                </pre>
              </div>
            )}
            {run.stderr && (
              <div>
                <p className="text-[11px] tracking-wider text-nx-faint uppercase">Errors</p>
                <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-nx-error/10 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-nx-error" data-testid="run-stderr">
                  {run.stderr}
                </pre>
              </div>
            )}
            {run.files.length > 0 && (
              <div>
                <p className="text-[11px] tracking-wider text-nx-faint uppercase">Files it created</p>
                <ul className="mt-1 flex flex-wrap gap-2">
                  {run.files.map((f) => (
                    <li key={f.name}>
                      <a href={runFileUrl(run.id, f.name)} download className="rounded-lg px-2 py-1 text-xs text-nx-indigo ring-1 ring-nx-line-strong hover:text-nx-cyan">
                        ⬇ {f.name} ({size(f.size)})
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}
        <div className="flex justify-end gap-2">
          {run?.status === "pending_approval" ? (
            <>
              <button type="button" onClick={close} className={ghostBtn}>
                Don&apos;t run
              </button>
              <button type="button" onClick={() => void approve()} disabled={busy} className={primaryBtn} autoFocus>
                {busy ? "Starting…" : "Approve and run"}
              </button>
            </>
          ) : (
            <button type="button" onClick={onClose} className={primaryBtn}>
              {finished || !run ? "Close" : "Close (keeps running)"}
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}
