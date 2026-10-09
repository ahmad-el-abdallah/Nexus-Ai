/** Client for apps (`/api/apps`): web applications the engineering team builds, stores and runs. */

import { request } from "./employees";

export type AppStatus = "planning" | "awaiting_approval" | "building" | "checking" | "reviewing" | "fixing" | "delivering" | "ready" | "paused" | "failed" | "cancelled";
export type AppFileStatus = "planned" | "writing" | "fixing" | "written" | "failed";
export type AppRunStatus = "installing" | "starting" | "running" | "stopped" | "failed";
export type AppArea = "backend" | "frontend" | "setup" | "docs";

export interface AppSummary {
  id: string;
  name: string;
  description: string;
  /** The newest version (it may still be in progress). */
  version: number;
  /** The newest finished version, if any: what can be downloaded and run. */
  ready_version: number | null;
  status: AppStatus;
  status_reason: string | null;
  stack: string | null;
  files: { total: number; written: number; failed: number };
  calls_used: number;
  max_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  source_conversation_id: string | null;
  created_at: string | null;
  finished_at: string | null;
}

export interface AppFile {
  id: number;
  path: string;
  area: AppArea;
  purpose: string;
  /** new | modify | keep (carried over unchanged from the previous version). */
  action: "new" | "modify" | "keep";
  instructions: string | null;
  employee_id: string | null;
  author_name: string | null;
  author_role: string | null;
  status: AppFileStatus;
  error: string | null;
  size: number;
  lines: number;
  /** The automatic syntax check: ok | failed | skipped (not checkable), null before it ran. */
  check: "ok" | "failed" | "skipped" | null;
  check_error: string | null;
  review_notes: string | null;
  revisions: number;
  attempts: number;
  calls: number;
}

export interface AppVersion {
  number: number;
  base_version: number | null;
  request: string;
  status: AppStatus;
  status_reason: string | null;
  stack: string | null;
  summary: string | null;
  tree_sha256: string | null;
  calls_used: number;
  max_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  created_at: string | null;
  approved_at: string | null;
  finished_at: string | null;
}

export interface AppPlan {
  name: string;
  summary: string;
  stack: string;
  api: string;
  packages: string[];
  files: { path: string; purpose: string }[];
  change?: { summary: string; files: { path: string; action: "modify" | "add" | "delete"; instructions: string; purpose: string }[] };
}

export interface AppEvent {
  id: number;
  app_id: string;
  version: number;
  created_at: string;
  kind: string;
  actor_id: string | null;
  actor_name: string | null;
  path: string | null;
  text: string;
}

export interface AppRun {
  id: string;
  app_id: string;
  version: number;
  tree_sha256: string;
  status: AppRunStatus;
  error: string | null;
  log: string;
  approved_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface AppRuntime {
  available: boolean;
  reason: string | null;
  /** Where a running app is reached on this computer: http://localhost:<port>. */
  port: number | null;
  python_packages: boolean;
  node: boolean;
  registries: string[];
  limits: { memory: string; processes: number; minutes: number; install_minutes: number; network: boolean; files: string };
  active: { run_id: string; app_id: string; app_name: string; version: number; status: AppRunStatus } | null;
}

export interface AppDependencies {
  file: string;
  registry: string;
  packages: string[];
}

export interface AppDetail extends AppSummary {
  versions: AppVersion[];
  current: AppVersion & {
    plan: AppPlan | null;
    stack_name: string | null;
    architect: { id: string; name: string; role: string } | null;
    files: AppFile[];
    estimate: { typical: number; worst: number } | null;
    known_issues: string[];
    dependencies: AppDependencies[];
  };
  events: AppEvent[];
  run: AppRun | null;
  runtime: AppRuntime;
}

export const APP_STATUS_TEXT: Record<AppStatus, string> = {
  planning: "Being designed",
  awaiting_approval: "Waiting for your approval",
  building: "Engineers are writing",
  checking: "Checking syntax",
  reviewing: "In review",
  fixing: "Fixing problems",
  delivering: "Writing the delivery note",
  ready: "Ready",
  paused: "Paused",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const APP_ACTIVE: AppStatus[] = ["planning", "building", "checking", "reviewing", "fixing", "delivering"];
export const APP_FINISHED: AppStatus[] = ["ready", "failed", "cancelled"];

export const RUN_STATUS_TEXT: Record<AppRunStatus, string> = {
  installing: "Installing packages in the sandbox…",
  starting: "Starting…",
  running: "Running in the sandbox",
  stopped: "Stopped",
  failed: "Did not run",
};
export const RUN_ACTIVE: AppRunStatus[] = ["installing", "starting", "running"];

export const AREA_TEXT: Record<AppArea, string> = { backend: "Backend", frontend: "Frontend", setup: "Setup", docs: "Docs" };

/**
 * The address of a running app. It is served on this computer only (127.0.0.1), on its
 * own port — a separate origin from NEXUS — so it opens only where NEXUS itself runs.
 */
export function previewUrl(port: number | null, hostname: string): string | null {
  if (!port || !["localhost", "127.0.0.1"].includes(hostname)) return null;
  return `http://${hostname}:${port}/`;
}

const post = <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const fetchApps = () => request<AppSummary[]>("/api/apps");
export const fetchApp = (id: string, version?: number) => request<AppDetail>(`/api/apps/${id}${version ? `?version=${version}` : ""}`);
export const createApp = (body: { description?: string; source_message_id?: number }) => post<AppDetail>("/api/apps", body);
export const approveApp = (id: string) => post<AppDetail>(`/api/apps/${id}/approve`);
export const cancelApp = (id: string) => post<AppDetail>(`/api/apps/${id}/cancel`);
export const resumeApp = (id: string) => post<AppDetail>(`/api/apps/${id}/resume`);
export const requestAppChange = (id: string, change: string) => post<AppDetail>(`/api/apps/${id}/changes`, { request: change });
export const deleteApp = (id: string) => request<void>(`/api/apps/${id}`, { method: "DELETE" });
export const fetchAppFile = (id: string, version: number, path: string) =>
  request<AppFile & { content: string }>(`/api/apps/${id}/versions/${version}/file?path=${encodeURIComponent(path)}`);
export const appDownloadUrl = (id: string, version: number) => `/api/apps/${id}/versions/${version}/download`;
/** The owner's approval of this exact version (identified by the hash of its files). */
export const runApp = (id: string, version: number, tree_sha256: string) => post<AppRun>(`/api/apps/${id}/versions/${version}/run`, { tree_sha256 });
export const stopAppRun = (runId: string) => post<AppRun>(`/api/apps/runs/${runId}/stop`);
