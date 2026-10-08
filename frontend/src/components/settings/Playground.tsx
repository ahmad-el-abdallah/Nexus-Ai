"use client";

import { type FormEvent, useRef, useState } from "react";

import { type AISettings, streamPlayground } from "@/lib/ai";
import { useEmployeeStore } from "@/world/state/employeeStore";

import { ghostBtn, input, labelCls, primaryBtn, Section } from "./ui";

interface Run {
  model?: string;
  source?: string;
  employee?: string | null;
  text: string;
  thinking: boolean;
  done?: { first_token_ms: number | null; latency_ms: number; prompt_tokens: number | null; completion_tokens: number | null; reasoning_tokens: number | null; empty: boolean; finish_reason: string | null };
  error?: string;
}

/** Talk to one employee through their routed model, streamed token by token. */
export function Playground({ settings, onFinished }: { settings: AISettings; onFinished: () => void }) {
  const employees = useEmployeeStore((s) => s.employees);
  const [employeeId, setEmployeeId] = useState("");
  const [message, setMessage] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setRun({ text: "", thinking: false });
    try {
      for await (const ev of streamPlayground({ message, employee_id: employeeId || undefined }, controller.signal)) {
        setRun((r) => {
          const cur = r ?? { text: "", thinking: false };
          switch (ev.type) {
            case "meta":
              return { ...cur, model: ev.model, source: ev.source, employee: ev.employee };
            case "thinking":
              return { ...cur, thinking: true };
            case "token":
              return { ...cur, text: cur.text + ev.text };
            case "done":
              return { ...cur, done: ev };
            case "error":
              return { ...cur, error: ev.message };
          }
        });
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") setRun((r) => ({ ...(r ?? { text: "", thinking: false }), error: (err as Error).message }));
      else setRun((r) => ({ ...(r ?? { text: "", thinking: false }), error: "Stopped." }));
    } finally {
      setBusy(false);
      onFinished();
    }
  };

  const selected = employees.find((e) => e.id === employeeId);
  return (
    <Section id="playground-title" title="Playground" aside="Each message uses one request from the daily budget">
      <form onSubmit={send} className="grid grid-cols-1 gap-3 md:grid-cols-[16rem_minmax(0,1fr)_auto] md:items-end">
        <label className={labelCls}>
          Talk to
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className={input}>
            <option value="">The default model directly</option>
            {[...employees].sort((a, b) => a.name.localeCompare(b.name)).map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} — {e.role}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          Message
          <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder={selected ? `Ask ${selected.name.split(" ")[0]} something…` : "Ask something…"} className={input} maxLength={8000} />
        </label>
        <div className="flex gap-2">
          <button type="submit" disabled={busy || !message.trim() || settings.paused} className={primaryBtn}>
            {busy ? "Streaming…" : "Send"}
          </button>
          {busy && (
            <button type="button" onClick={() => abort.current?.abort()} className={ghostBtn}>
              Stop
            </button>
          )}
        </div>
      </form>
      {run && (
        <div className="mt-4 rounded-xl bg-white/[0.03] p-4 ring-1 ring-nx-line" data-testid="playground-output" aria-live="polite">
          {run.model && (
            <p className="mb-2 text-xs text-nx-faint">
              {run.employee ? `${run.employee} · ` : ""}
              <span className="font-mono">{run.model}</span> ({run.source})
            </p>
          )}
          <p className="text-sm whitespace-pre-wrap text-nx-text" data-testid="playground-text">
            {run.text}
            {busy && !run.text && (run.thinking ? <span className="text-nx-muted">Thinking…</span> : <span className="text-nx-muted">Waiting for the first token…</span>)}
          </p>
          {run.done && (
            <p className="mt-3 font-mono text-[11px] text-nx-faint" data-testid="playground-stats">
              first token {run.done.first_token_ms ?? "—"} ms · total {run.done.latency_ms} ms · tokens {run.done.prompt_tokens ?? "—"} in / {run.done.completion_tokens ?? "—"} out
              {run.done.reasoning_tokens ? ` (${run.done.reasoning_tokens} reasoning)` : ""} · {run.done.finish_reason ?? "—"}
            </p>
          )}
          {run.done?.empty && (
            <p className="mt-2 text-xs text-nx-warn">The model used all its output tokens on reasoning. Increase “max output tokens” and try again.</p>
          )}
          {run.error && (
            <p role="alert" className="mt-2 text-sm text-nx-error">
              {run.error}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}
