/** Client for employee profiles (`/api/employees/{id}/profile`, feedback). */

import { request } from "./employees";

export interface TaskBrief {
  id: string;
  title: string;
  status: string;
  kind: string;
  workflow_id: string | null;
  revisions: number;
  created_at: string | null;
  finished_at: string | null;
  has_result: boolean;
}

export interface Performance {
  tasks_done: number;
  tasks_failed: number;
  revisions_requested: number;
  runs_succeeded: number;
  runs_failed: number;
  finished_items: number;
  /** Percent (0-100) of finished tasks and runs that succeeded; null when no evidence. */
  success_rate: number | null;
  basis: string;
}

export interface Feedback {
  id: number;
  rating: number | null;
  note: string | null;
  created_at: string | null;
}

export interface HistoryEntry {
  id: number;
  kind: string;
  text: string;
  created_at: string | null;
}

export interface RunBrief {
  id: string;
  language: string;
  status: string;
  created_at: string | null;
  files: number;
}

export interface Profile {
  id: string;
  name: string;
  role: string;
  department: string;
  department_name: string;
  seniority: string;
  gender: string | null;
  desk_id: string | null;
  avatar_seed: number;
  status: string;
  status_detail: string | null;
  status_changed_at: string | null;
  model_id: string | null;
  manager: { id: string; name: string; role: string } | null;
  reports: { id: string; name: string; role: string }[];
  skills: string[];
  performance: Performance;
  rating: { average: number | null; count: number };
  active_assignments: TaskBrief[];
  task_history: TaskBrief[];
  runs: RunBrief[];
  feedback: Feedback[];
  history: HistoryEntry[];
  generated_at: string;
}

export const fetchProfile = (id: string) => request<Profile>(`/api/employees/${id}/profile`);
export const saveSkills = (id: string, skills: string[]) =>
  request(`/api/employees/${id}`, { method: "PATCH", body: JSON.stringify({ skills }) });
export const addFeedback = (id: string, body: { rating?: number | null; note?: string | null }) =>
  request<Profile>(`/api/employees/${id}/feedback`, { method: "POST", body: JSON.stringify(body) });
export const deleteFeedback = (id: string, feedbackId: number) =>
  request<void>(`/api/employees/${id}/feedback/${feedbackId}`, { method: "DELETE" });

export const HISTORY_LABEL: Record<string, string> = {
  hired: "Hired",
  renamed: "Renamed",
  role_changed: "Role changed",
  department_changed: "Moved department",
  seniority_changed: "Seniority changed",
  desk_changed: "Desk changed",
  model_changed: "AI model changed",
  suspended: "Suspended",
  activated: "Reactivated",
  rated: "Owner rating",
  feedback: "Owner note",
};
