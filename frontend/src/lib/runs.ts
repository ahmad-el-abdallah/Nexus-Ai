/** Client for sandbox runs (`/api/runs`): employee code the owner approves to run. */

import { request } from "./employees";

export type RunStatus = "pending_approval" | "running" | "succeeded" | "failed" | "timed_out" | "killed" | "rejected" | "error";

export interface CodeRun {
  id: string;
  language: "python" | "javascript" | "bash";
  code: string;
  code_sha256: string;
  status: RunStatus;
  message_id: number | null;
  task_id: string | null;
  employee_id: string | null;
  author_name: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  stdout: string;
  stderr: string;
  files: { name: string; size: number }[];
  error: string | null;
  created_at: string | null;
  approved_at: string | null;
  finished_at: string | null;
}

export interface RunCapabilities {
  available: boolean;
  languages: string[];
  reason: string | null;
  limits: { timeout_seconds: number; memory: string; processes: number; network: boolean; files: string };
}

const RUNNABLE: Record<string, string> = { python: "python", py: "python", python3: "python", javascript: "javascript", js: "javascript", node: "javascript", nodejs: "javascript", bash: "bash", sh: "bash", shell: "bash" };

/** The sandbox language for a code block's tag, or null when it can't be run. */
export const runnableLanguage = (tag: string) => RUNNABLE[tag.toLowerCase()] ?? null;

export const RUN_STATUS_TEXT: Record<RunStatus, string> = {
  pending_approval: "Waiting for your approval",
  running: "Running in the sandbox…",
  succeeded: "Finished",
  failed: "Finished with an error",
  timed_out: "Stopped: time limit",
  killed: "Stopped: sandbox limit",
  rejected: "Not run",
  error: "The sandbox couldn't run it",
};

export const fetchCapabilities = () => request<RunCapabilities>("/api/runs/capabilities");
export const prepareRun = (body: { code: string; language: string; message_id?: number | null; task_id?: string | null }) =>
  request<CodeRun>("/api/runs", { method: "POST", body: JSON.stringify(body) });
/** The owner's approval of the exact code the server stored (identified by its SHA-256). */
export const approveRun = (run: CodeRun) => request<CodeRun>(`/api/runs/${run.id}/approve`, { method: "POST", body: JSON.stringify({ code_sha256: run.code_sha256 }) });
export const rejectRun = (id: string) => request<CodeRun>(`/api/runs/${id}/reject`, { method: "POST" });
export const fetchRun = (id: string) => request<CodeRun>(`/api/runs/${id}`);
export const runFileUrl = (id: string, name: string) => `/api/runs/${id}/files/${encodeURIComponent(name)}`;

const EXTENSIONS: Record<string, string> = { python: "py", py: "py", javascript: "js", js: "js", typescript: "ts", ts: "ts", bash: "sh", sh: "sh", shell: "sh", json: "json", html: "html", css: "css", sql: "sql", yaml: "yaml", yml: "yml", csv: "csv", md: "md", markdown: "md" };
export const extensionFor = (tag: string) => EXTENSIONS[tag.toLowerCase()] ?? "txt";
