/** Read-only Digital Vault metadata shown in the 3D Data Center room. */

import { request } from "./employees";

export interface StorageOverview {
  status: "metadata_ready";
  backend: string;
  writes_enabled: false;
  workspace_count: number;
  department_workspace_count: number;
  entry_count: number;
  file_count: number;
  folder_count: number;
  version_count: number;
  stored_bytes: number;
  quota_bytes_per_department: number;
  backup_configured: boolean;
  last_event_at: string | null;
}

export const fetchStorageOverview = () => request<StorageOverview>("/api/storage/overview");
