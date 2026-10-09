"use client";

import type { TaskStatus } from "@/lib/chat";
import { TASK_STATUS_LABEL } from "@/lib/chat";
import { STATUS_TEXT, type WorkflowStatus } from "@/lib/workflows";

type Tone = "ok" | "warn" | "error" | "info" | "neutral" | "violet";

const TONES: Record<Tone, string> = {
  ok: "bg-nx-ok/10 text-nx-ok ring-nx-ok/30",
  warn: "bg-nx-warn/10 text-nx-warn ring-nx-warn/30",
  error: "bg-nx-error/10 text-nx-error ring-nx-error/30",
  info: "bg-nx-cyan/10 text-nx-cyan ring-nx-cyan/30",
  violet: "bg-nx-violet/15 text-nx-violet ring-nx-violet/40",
  neutral: "bg-white/5 text-nx-muted ring-nx-line-strong",
};

const WORKFLOW_TONE: Record<WorkflowStatus, Tone> = {
  planning: "info",
  awaiting_approval: "violet",
  running: "info",
  consolidating: "info",
  paused: "warn",
  completed: "ok",
  partial: "warn",
  failed: "error",
  cancelled: "neutral",
};

const TASK_TONE: Record<TaskStatus, Tone> = {
  open: "neutral",
  proposed: "violet",
  queued: "neutral",
  planning: "info",
  active: "info",
  running: "info",
  awaiting_review: "info",
  reviewing: "info",
  summarizing: "info",
  done: "ok",
  failed: "error",
  skipped: "warn",
  cancelled: "neutral",
};

const LIVE: TaskStatus[] = ["planning", "running", "reviewing", "summarizing"];

function Chip({ tone, live, children, testId }: { tone: Tone; live?: boolean; children: React.ReactNode; testId?: string }) {
  return (
    <span data-testid={testId} className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ${TONES[tone]}`}>
      {live && <span className="nx-pulse size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function WorkflowStatusChip({ status }: { status: WorkflowStatus }) {
  return (
    <Chip tone={WORKFLOW_TONE[status]} live={status === "planning" || status === "running" || status === "consolidating"} testId="workflow-status">
      {STATUS_TEXT[status]}
    </Chip>
  );
}

export function TaskStatusChip({ status }: { status: TaskStatus }) {
  return (
    <Chip tone={TASK_TONE[status]} live={LIVE.includes(status)}>
      {TASK_STATUS_LABEL[status]}
    </Chip>
  );
}

export function UsageBar({ used, max, of = "workflow" }: { used: number; max: number; of?: string }) {
  const share = max ? Math.min(1, used / max) : 0;
  return (
    <div className="flex items-center gap-2" title={`Model requests used by this ${of}, out of its hard limit`}>
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full ${share > 0.85 ? "bg-nx-warn" : "bg-nx-cyan"}`} style={{ width: `${share * 100}%` }} />
      </div>
      <span className="font-mono text-[11px] text-nx-muted">
        {used}/{max} requests
      </span>
    </div>
  );
}
