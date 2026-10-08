/** Client for workflows (`/api/workflows`): CEO delegation, approval, progress, results. */

import type { Task } from "./chat";
import { request } from "./employees";

export type WorkflowStatus = "planning" | "awaiting_approval" | "running" | "consolidating" | "paused" | "completed" | "partial" | "failed" | "cancelled";

export interface WorkflowSummary {
  id: string;
  title: string;
  objective: string;
  status: WorkflowStatus;
  status_reason: string | null;
  ceo_id: string | null;
  departments: string[];
  assignments: { total: number; done: number; failed: number };
  /** Worker tasks by status. */
  work: Partial<Record<Task["status"], number>>;
  calls_used: number;
  max_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  steps_in_flight: number;
  source_conversation_id: string | null;
  source_task_id: string | null;
  created_at: string | null;
  approved_at: string | null;
  finished_at: string | null;
}

export interface WorkflowEvent {
  id: number;
  workflow_id: string;
  task_id: string | null;
  created_at: string;
  kind: string;
  actor_id: string | null;
  actor_name: string | null;
  from_department: string | null;
  to_department: string | null;
  text: string;
}

export interface WorkflowPlan {
  summary: string;
  deliverable: string;
  assignments: { id: string; department: string; title: string; instructions: string; depends_on: string[] }[];
}

export interface WorkflowDetail extends WorkflowSummary {
  plan: WorkflowPlan | null;
  result: string | null;
  estimate: { typical: number; worst: number } | null;
  tasks: Task[];
  events: WorkflowEvent[];
}

export const STATUS_TEXT: Record<WorkflowStatus, string> = {
  planning: "CEO is planning",
  awaiting_approval: "Waiting for your approval",
  running: "Running",
  consolidating: "CEO is writing the report",
  paused: "Paused",
  completed: "Completed",
  partial: "Completed with failures",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const FINISHED: WorkflowStatus[] = ["completed", "partial", "failed", "cancelled"];

export const fetchWorkflows = () => request<WorkflowSummary[]>("/api/workflows");
export const fetchWorkflow = (id: string) => request<WorkflowDetail>(`/api/workflows/${id}`);
export const createWorkflow = (body: { objective?: string; source_message_id?: number; source_task_id?: string; source_conversation_id?: string; max_calls?: number }) =>
  request<WorkflowDetail>("/api/workflows", { method: "POST", body: JSON.stringify(body) });
export const approveWorkflow = (id: string, exclude: string[] = []) =>
  request<WorkflowDetail>(`/api/workflows/${id}/approve`, { method: "POST", body: JSON.stringify({ exclude }) });
export const cancelWorkflow = (id: string) => request<WorkflowDetail>(`/api/workflows/${id}/cancel`, { method: "POST" });
export const resumeWorkflow = (id: string) => request<WorkflowDetail>(`/api/workflows/${id}/resume`, { method: "POST" });
export const cancelWorkflowTask = (id: string, taskId: string) => request<WorkflowDetail>(`/api/workflows/${id}/tasks/${taskId}/cancel`, { method: "POST" });
