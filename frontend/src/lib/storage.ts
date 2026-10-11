/** Typed Digital Vault client. Browser code only handles opaque IDs and safe metadata. */

import { ApiError, request } from "./employees";

export interface StorageOverview {
  status: "metadata_ready";
  backend: string;
  writes_enabled: boolean;
  workspace_count: number;
  department_workspace_count: number;
  entry_count: number;
  file_count: number;
  folder_count: number;
  version_count: number;
  active_grant_count: number;
  linked_entry_count: number;
  read_only_workspace_count: number;
  stored_bytes: number;
  quota_bytes_per_department: number;
  backup_configured: boolean;
  backup_snapshot_count: number;
  last_backup_at: string | null;
  unavailable_version_count: number;
  integrity_checked_at: string | null;
  last_event_at: string | null;
}

export interface StorageWorkspace {
  id: string;
  scope: "company" | "department";
  department_key: string | null;
  state: "active" | "read_only";
  used_bytes: number;
  quota_bytes: number;
  quota_override_bytes: number | null;
}

export type PreviewKind = "none" | "text" | "csv" | "image" | "pdf" | "audio" | "video" | "download";

export interface StorageEntry {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  kind: "folder" | "file";
  name: string;
  path: string;
  description: string | null;
  status: "pending" | "available" | "failed" | "missing" | "quarantined";
  current_version_number: number;
  size_bytes: number | null;
  mime_type: string | null;
  sha256: string | null;
  tags: string[];
  favorite: boolean;
  preview_kind: PreviewKind;
  trashed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StorageVersion {
  id: string;
  number: number;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  status: "available" | "missing" | "quarantined";
  is_current: boolean;
  change_description: string | null;
  created_by_kind: "owner" | "employee" | "system";
  created_by_name: string | null;
  created_at: string;
}

export interface StorageLink {
  id: string;
  entry_id: string;
  version_id: string | null;
  target_type:
    | "task"
    | "workflow"
    | "app"
    | "app_version"
    | "app_file"
    | "code_run"
    | "message";
  target_id: string;
  relation: string;
  label: string | null;
  created_at: string;
}

export interface StorageEvent {
  id: number;
  kind: string;
  level: "info" | "warn" | "error";
  actor_name: string | null;
  text: string;
  created_at: string;
}

export interface StorageEntryDetail extends StorageEntry {
  original_name: string | null;
  artifact_type: string | null;
  visibility: "private" | "department" | "shared" | "company";
  created_by_kind: "owner" | "employee" | "system";
  created_by_employee_id: string | null;
  created_by_name: string | null;
  owner_kind: "company" | "department" | "employee";
  owner_id: string;
  owner_name: string;
  /** The file mirrors a task, workflow, app file, code run or attachment and follows it. */
  source_managed: boolean;
  versions: StorageVersion[];
  links: StorageLink[];
  events: StorageEvent[];
}

export interface StorageSearch {
  items: StorageEntry[];
  total: number;
  offset: number;
  limit: number;
}

export const fetchStorageOverview = () => request<StorageOverview>("/api/storage/overview");
export const fetchWorkspaces = () => request<StorageWorkspace[]>("/api/storage/workspaces");
export const fetchEntries = (workspaceId: string, parentId: string | null, trashed = false) => {
  const params = new URLSearchParams({ trashed: String(trashed) });
  if (parentId) params.set("parent_id", parentId);
  return request<StorageEntry[]>(`/api/storage/workspaces/${encodeURIComponent(workspaceId)}/entries?${params}`);
};

export interface SearchOptions {
  workspace_id?: string;
  q?: string;
  kind?: "folder" | "file";
  tag?: string;
  trashed?: boolean;
  /** Only items that are shared by name with a department or an employee. */
  shared?: boolean;
  sort?: "name" | "created" | "updated" | "type";
  order?: "asc" | "desc";
  offset?: number;
  limit?: number;
}

export const searchEntries = (options: SearchOptions) => {
  const params = new URLSearchParams();
  Object.entries(options).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  return request<StorageSearch>(`/api/storage/search?${params}`);
};

export const fetchEntry = (id: string) => request<StorageEntryDetail>(`/api/storage/entries/${id}`);
export const createFolder = (workspaceId: string, name: string, parentId: string | null) =>
  request<StorageEntry>(`/api/storage/workspaces/${encodeURIComponent(workspaceId)}/folders`, {
    method: "POST",
    body: JSON.stringify({ name, parent_id: parentId }),
  });
export const uploadFile = (workspaceId: string, file: File, parentId: string | null) => {
  const form = new FormData();
  form.set("file", file);
  if (parentId) form.set("parent_id", parentId);
  return request<StorageEntry>(`/api/storage/workspaces/${encodeURIComponent(workspaceId)}/files`, {
    method: "POST",
    body: form,
  });
};
export const updateEntry = (id: string, changes: Record<string, unknown>) =>
  request<StorageEntry>(`/api/storage/entries/${id}`, { method: "PATCH", body: JSON.stringify(changes) });
export const trashEntry = (id: string) => request<StorageEntry>(`/api/storage/entries/${id}`, { method: "DELETE" });
export const restoreEntry = (id: string) => request<StorageEntry>(`/api/storage/entries/${id}/restore`, { method: "POST" });
export const duplicateEntry = (id: string, changes: Record<string, unknown> = {}) =>
  request<StorageEntry>(`/api/storage/entries/${id}/duplicate`, { method: "POST", body: JSON.stringify(changes) });
export const permanentlyDeleteEntry = (id: string) =>
  request<{ items: number; versions: number; blobs_removed: number }>(`/api/storage/entries/${id}/permanent?confirm=true`, { method: "DELETE" });

const versionQuery = (version?: number) => (version ? `?version=${version}` : "");
export const previewUrl = (id: string, version?: number) => `/api/storage/entries/${encodeURIComponent(id)}/preview${versionQuery(version)}`;
export const downloadUrl = (id: string, version?: number) => `/api/storage/entries/${encodeURIComponent(id)}/download${versionQuery(version)}`;

/** Adds new content as the next version; earlier versions are kept unchanged. */
export const uploadVersion = (id: string, file: File, changeDescription?: string) => {
  const form = new FormData();
  form.set("file", file);
  if (changeDescription?.trim()) form.set("change_description", changeDescription.trim());
  return request<StorageEntry>(`/api/storage/entries/${encodeURIComponent(id)}/versions`, { method: "POST", body: form });
};
/** Makes an older version current by appending a copy of it. */
export const restoreVersion = (id: string, version: number) =>
  request<StorageEntry>(`/api/storage/entries/${encodeURIComponent(id)}/versions/${version}/restore`, { method: "POST" });

export interface DiffSide {
  entry_id: string;
  name: string;
  path: string;
  version: number;
  size_bytes: number;
  sha256: string;
  created_by_name: string | null;
  created_at: string;
}

export interface DiffLine {
  kind: "hunk" | "context" | "add" | "remove";
  old: number | null;
  new: number | null;
  text: string;
}

export interface StorageDiff {
  before: DiffSide;
  after: DiffSide;
  identical: boolean;
  comparable: boolean;
  reason: string | null;
  line_endings_only: boolean;
  added: number;
  removed: number;
  truncated: boolean;
  lines: DiffLine[];
}

export interface DiffRequest {
  beforeEntry: string;
  beforeVersion?: number;
  afterEntry: string;
  afterVersion?: number;
}

export const fetchDiff = ({ beforeEntry, beforeVersion, afterEntry, afterVersion }: DiffRequest) => {
  const params = new URLSearchParams({ before_entry: beforeEntry, after_entry: afterEntry });
  if (beforeVersion) params.set("before_version", String(beforeVersion));
  if (afterVersion) params.set("after_version", String(afterVersion));
  return request<StorageDiff>(`/api/storage/diff?${params}`);
};

export interface StorageProject {
  id: string;
  name: string;
  description: string;
  current_version: number;
  latest_status: string | null;
  version_count: number;
  ready_version_count: number;
  stored_file_count: number;
  stored_bytes: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectFile {
  path: string;
  area: string;
  purpose: string;
  author_name: string | null;
  author_role: string | null;
  entry_id: string | null;
  /** "available", another storage status, "trashed", or "not_stored". */
  state: string;
  size_bytes: number | null;
  sha256: string | null;
  change: "added" | "modified" | "unchanged" | null;
  previous_entry_id: string | null;
}

export interface ProjectVersion {
  id: string;
  number: number;
  base_version: number | null;
  status: string;
  request: string;
  stack: string | null;
  tree_sha256: string | null;
  finished_at: string | null;
  folder_id: string | null;
  stored_file_count: number;
  stored_bytes: number;
  files: ProjectFile[];
  removed: string[];
}

export interface StorageProjectDetail {
  id: string;
  name: string;
  description: string;
  current_version: number;
  created_at: string;
  updated_at: string;
  versions: ProjectVersion[];
}

export const fetchProjects = () => request<StorageProject[]>("/api/storage/projects");
export const fetchProject = (id: string) => request<StorageProjectDetail>(`/api/storage/projects/${encodeURIComponent(id)}`);

export interface DashboardWorkspace extends StorageWorkspace {
  name: string;
  file_count: number;
}

export interface StorageDashboard {
  generated_at: string;
  utc_offset_minutes: number;
  totals: {
    files: number;
    folders: number;
    trashed: number;
    versions: number;
    stored_bytes: number;
    unavailable_files: number;
    error_events: number;
    registration_failures: number;
  };
  workspaces: DashboardWorkspace[];
  by_type: { artifact_type: string | null; files: number; bytes: number }[];
  by_creator: { kind: "owner" | "employee" | "system"; files: number }[];
  top_creators: { employee_id: string; name: string | null; files: number }[];
  activity: { date: string; events: number; errors: number }[];
  recent_events: (StorageEvent & { workspace_id: string | null })[];
  projects: { apps: number; ready_versions: number; stored_files: number } | null;
}

/** Days in the activity chart are the viewer's own calendar days. */
export const fetchDashboard = () =>
  request<StorageDashboard>(`/api/storage/dashboard?utc_offset_minutes=${-new Date().getTimezoneOffset()}`);

export async function fetchTextPreview(id: string, version?: number): Promise<{ text: string; truncated: boolean }> {
  const response = await fetch(previewUrl(id, version), { cache: "no-store" });
  if (!response.ok) {
    const body = response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
    throw new ApiError(typeof body?.detail === "string" ? body.detail : `Preview failed (${response.status})`, response.status);
  }
  return { text: await response.text(), truncated: response.headers.get("x-preview-truncated") === "true" };
}

function filenameFromDisposition(value: string | null): string {
  const encoded = value?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  return encoded ? decodeURIComponent(encoded) : "nexus-vault-export.zip";
}

export async function exportEntries(ids: string[]): Promise<void> {
  const response = await fetch("/api/storage/export", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/zip" },
    body: JSON.stringify({ entry_ids: ids }),
  });
  if (!response.ok) {
    const body = response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
    throw new ApiError(typeof body?.detail === "string" ? body.detail : `Export failed (${response.status})`, response.status);
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filenameFromDisposition(response.headers.get("content-disposition"));
  anchor.click();
  URL.revokeObjectURL(url);
}

export interface StorageGrant {
  id: string;
  workspace_id: string;
  entry_id: string | null;
  grantee_kind: "employee" | "department";
  grantee_id: string;
  permission: "read" | "write" | "manage";
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** A live grant with the names needed to show it; `inherited` means it comes from a folder above or the whole workspace. */
export interface StorageGrantDetail extends StorageGrant {
  grantee_name: string | null;
  entry_name: string | null;
  entry_path: string | null;
  entry_kind: "folder" | "file" | null;
  inherited: boolean;
}

export interface GrantRequest {
  grantee_kind: "employee" | "department";
  grantee_id: string;
  permission: "read" | "write";
  entry_id: string | null;
  expires_at: string | null;
}

export const fetchGrants = (entryId?: string) =>
  request<StorageGrantDetail[]>(`/api/storage/grants${entryId ? `?entry_id=${encodeURIComponent(entryId)}` : ""}`);
export const createGrant = (workspaceId: string, body: GrantRequest) =>
  request<StorageGrant>(`/api/storage/workspaces/${encodeURIComponent(workspaceId)}/grants`, { method: "POST", body: JSON.stringify(body) });
export const revokeGrant = (id: string) => request<StorageGrant>(`/api/storage/grants/${encodeURIComponent(id)}`, { method: "DELETE" });

export interface BackupSnapshot {
  id: string;
  created_at: string | null;
  status: "complete" | "partial" | "unreadable";
  files: number;
  versions: number;
  bytes: number;
  skipped_versions: number;
  verified_at: string | null;
  verified_ok: boolean | null;
}

export interface BackupStatus {
  configured: boolean;
  /** True when the backups are on the same drive as the Vault; null when that could not be determined. */
  same_device: boolean | null;
  keep: number;
  last_backup_at: string | null;
  snapshots: BackupSnapshot[];
}

export interface BackupVerification {
  id: string;
  healthy: boolean;
  manifest_ok: boolean;
  checked: number;
  ok: number;
  missing: number;
  corrupt: number;
  verified_at: string;
}

export interface DeletedFile {
  entry_id: string;
  workspace_id: string;
  name: string;
  path: string;
  version: number;
  size_bytes: number;
  recoverable: boolean;
  /** Where identical content already is in the same workspace, if anywhere. */
  present_at: string | null;
}

export interface IntegrityCheck {
  checked: number;
  missing: number;
  corrupt: number;
  recovered: number;
  orphaned: number;
  unsafe: number;
}

export interface IntegrityReport {
  last_check: (IntegrityCheck & { at: string }) | null;
  damaged_total: number;
  damaged: {
    entry_id: string;
    workspace_id: string;
    name: string;
    path: string;
    version: number;
    is_current: boolean;
    status: "missing" | "quarantined";
    size_bytes: number;
  }[];
}

export interface RepairReport {
  examined: number;
  repaired: number;
  not_in_backup: number;
  failed: number;
}

export interface CleanupReport {
  removed_objects: number;
  removed_bytes: number;
  removed_temporary: number;
  kept_recent: number;
  unsafe: number;
}

export const fetchBackups = () => request<BackupStatus>("/api/storage/backups");
export const createBackup = () => request<BackupSnapshot>("/api/storage/backups", { method: "POST" });
export const verifyBackup = (id: string) => request<BackupVerification>(`/api/storage/backups/${encodeURIComponent(id)}/verify`, { method: "POST" });
export const fetchDeletedFiles = (id: string) =>
  request<{ id: string; total: number; items: DeletedFile[] }>(`/api/storage/backups/${encodeURIComponent(id)}/deleted`);
/** Re-creates a deleted file from a backup as a new file in "Recovered from backup". */
export const recoverFile = (snapshotId: string, entryId: string) =>
  request<StorageEntry>(`/api/storage/backups/${encodeURIComponent(snapshotId)}/recover`, { method: "POST", body: JSON.stringify({ entry_id: entryId }) });
export const fetchIntegrity = () => request<IntegrityReport>("/api/storage/maintenance/integrity");
export const checkIntegrity = () => request<IntegrityCheck>("/api/storage/maintenance/reconcile", { method: "POST" });
export const repairFromBackup = () => request<RepairReport>("/api/storage/maintenance/repair", { method: "POST" });
export const cleanupStorage = () =>
  request<CleanupReport>("/api/storage/maintenance/cleanup", { method: "POST", body: JSON.stringify({ confirm: true }) });
