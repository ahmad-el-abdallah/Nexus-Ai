"use client";

import { APP_ACTIVE, APP_STATUS_TEXT, type AppFile, type AppRunStatus, type AppStatus, RUN_ACTIVE, RUN_STATUS_TEXT } from "@/lib/apps";

type Tone = "ok" | "warn" | "error" | "info" | "neutral" | "violet";

const TONES: Record<Tone, string> = {
  ok: "bg-nx-ok/10 text-nx-ok ring-nx-ok/30",
  warn: "bg-nx-warn/10 text-nx-warn ring-nx-warn/30",
  error: "bg-nx-error/10 text-nx-error ring-nx-error/30",
  info: "bg-nx-cyan/10 text-nx-cyan ring-nx-cyan/30",
  violet: "bg-nx-violet/15 text-nx-violet ring-nx-violet/40",
  neutral: "bg-white/5 text-nx-muted ring-nx-line-strong",
};

const APP_TONE: Record<AppStatus, Tone> = {
  planning: "info",
  awaiting_approval: "violet",
  building: "info",
  checking: "info",
  reviewing: "info",
  fixing: "info",
  delivering: "info",
  ready: "ok",
  paused: "warn",
  failed: "error",
  cancelled: "neutral",
};

const FILE_TEXT: Record<AppFile["status"], string> = { planned: "To write", writing: "Being written", fixing: "Being rewritten", written: "Written", failed: "Failed" };
const FILE_TONE: Record<AppFile["status"], Tone> = { planned: "neutral", writing: "info", fixing: "info", written: "ok", failed: "error" };
const RUN_TONE: Record<AppRunStatus, Tone> = { installing: "info", starting: "info", running: "ok", stopped: "neutral", failed: "error" };

export function Chip({ tone, live, children, testId }: { tone: Tone; live?: boolean; children: React.ReactNode; testId?: string }) {
  return (
    <span data-testid={testId} className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ${TONES[tone]}`}>
      {live && <span className="nx-pulse size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function AppStatusChip({ status }: { status: AppStatus }) {
  return (
    <Chip tone={APP_TONE[status]} live={APP_ACTIVE.includes(status)} testId="app-status">
      {APP_STATUS_TEXT[status]}
    </Chip>
  );
}

export function FileStatusChip({ file }: { file: AppFile }) {
  const kept = file.action === "keep" && file.status === "written";
  return (
    <Chip tone={kept ? "neutral" : FILE_TONE[file.status]} live={file.status === "writing" || file.status === "fixing"}>
      {kept ? "Unchanged" : FILE_TEXT[file.status]}
    </Chip>
  );
}

/** What the automatic syntax check found — "not checked" is never shown as a pass. */
export function CheckChip({ file }: { file: AppFile }) {
  if (file.status !== "written" || file.check === null) return null;
  if (file.check === "ok") return <Chip tone="ok">Syntax ok</Chip>;
  if (file.check === "failed") return <Chip tone="error">Check failed</Chip>;
  return <Chip tone="neutral">Not checked</Chip>;
}

export function RunStatusChip({ status }: { status: AppRunStatus }) {
  return (
    <Chip tone={RUN_TONE[status]} live={RUN_ACTIVE.includes(status)} testId="app-run-status">
      {RUN_STATUS_TEXT[status]}
    </Chip>
  );
}

export const btn = "rounded-lg px-3 py-2 text-sm ring-1 disabled:opacity-50";
export const primary = `${btn} bg-nx-violet/30 font-semibold text-white ring-nx-violet/60 hover:bg-nx-violet/40`;
export const ghost = `${btn} text-nx-text ring-nx-line-strong hover:bg-white/5`;
export const danger = `${btn} text-nx-warn ring-nx-warn/50 hover:bg-nx-warn/10`;
export const textarea =
  "w-full resize-y rounded-lg bg-nx-bg/80 px-3 py-2 text-sm leading-6 text-nx-text ring-1 ring-nx-line-strong placeholder:text-nx-faint focus:ring-nx-violet/60 focus:outline-none";
