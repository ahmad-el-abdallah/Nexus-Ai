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
  created_by_name: string | null;
  created_at: string;
}

export interface StorageLink {
  id: string;
  entry_id: string;
  version_id: string | null;
  target_type: "task" | "app" | "app_version";
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

export const previewUrl = (id: string) => `/api/storage/entries/${encodeURIComponent(id)}/preview`;
export const downloadUrl = (id: string) => `/api/storage/entries/${encodeURIComponent(id)}/download`;

export async function fetchTextPreview(id: string): Promise<{ text: string; truncated: boolean }> {
  const response = await fetch(previewUrl(id), { cache: "no-store" });
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
