/** Client for conversations, messages, attachments and tasks (`/api/conversations`, `/api/tasks`). */

import { request } from "./employees";

export type ConversationKind = "employee" | "department";
export type MessageStatus = "complete" | "streaming" | "stopped" | "error";
/** Progress of a reply being written: waiting for a slot → request sent → reasoning → text arriving. */
export type ReplyState = "queued" | "generating" | "thinking" | "writing" | "done";

export interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  readable: boolean;
  truncated: boolean;
}

export interface Message {
  id: number;
  conversation_id: string;
  created_at: string;
  /** "system": a notice from NEXUS AI itself (e.g. workflow progress), never a model's words. */
  role: "owner" | "agent" | "system";
  employee_id: string | null;
  author_name: string | null;
  author_role: string | null;
  author_department: string | null;
  content: string;
  /** "voice": content is the owner-reviewed transcript of a recording. */
  input_mode?: "text" | "voice";
  status: MessageStatus;
  error: string | null;
  error_kind: string | null;
  model: string | null;
  model_source: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  first_token_ms: number | null;
  latency_ms: number | null;
  context_messages: number | null;
  finished_at: string | null;
  attachments: Attachment[];
}

export interface Conversation {
  id: string;
  kind: ConversationKind;
  department: string;
  employee_id: string | null;
  title: string;
  created_at: string;
  last_message_at: string | null;
  message_count: number;
  last_message: { role: string; author_name: string | null; snippet: string; status: MessageStatus } | null;
  replying: boolean;
  match: { message_id: number | null; snippet: string } | null;
}

export type TaskStatus =
  | "open"
  | "proposed"
  | "queued"
  | "planning"
  | "active"
  | "running"
  | "awaiting_review"
  | "reviewing"
  | "summarizing"
  | "done"
  | "failed"
  | "skipped"
  | "cancelled";

export interface Task {
  id: string;
  title: string;
  description: string;
  department: string;
  assignee_id: string | null;
  status: TaskStatus;
  source_conversation_id: string | null;
  source_message_id: number | null;
  created_at: string;
  updated_at: string;
  /** "manual" (recorded by the owner), "assignment" (CEO → department) or "work" (a worker's task). */
  kind: "manual" | "assignment" | "work";
  workflow_id: string | null;
  parent_id: string | null;
  depends_on: string[];
  position: number;
  attempts: number;
  revisions: number;
  result: string | null;
  review_notes: string | null;
  error: string | null;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  started_at: string | null;
  finished_at: string | null;
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open · not started",
  proposed: "Proposed",
  queued: "Waiting",
  planning: "Supervisor planning",
  active: "In progress",
  running: "Working",
  awaiting_review: "Ready for review",
  reviewing: "In review",
  summarizing: "Summarising",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

/** Who a new conversation is addressed to. */
export type Target = { kind: "employee"; employee_id: string } | { kind: "department"; department: string };

export const MAX_FILES = 4;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function fetchConversations(params: { q?: string; department?: string; employee_id?: string } = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
  return request<Conversation[]>(`/api/conversations${query.size ? `?${query}` : ""}`);
}

export const fetchConversation = (id: string) => request<Conversation>(`/api/conversations/${id}`);
export const createConversation = (target: Target) =>
  request<Conversation>("/api/conversations", { method: "POST", body: JSON.stringify(target) });
export const renameConversation = (id: string, title: string) =>
  request<Conversation>(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title }) });
export const deleteConversation = (id: string) => request<void>(`/api/conversations/${id}`, { method: "DELETE" });
export const fetchMessages = (id: string) => request<Message[]>(`/api/conversations/${id}/messages`);
export const stopReply = (id: string) => request<{ stopped: boolean }>(`/api/conversations/${id}/stop`, { method: "POST" });
export const retryReply = (id: string) => request<Message>(`/api/conversations/${id}/reply`, { method: "POST" });

/** `replyStyle: "spoken"` in a live voice session: a short reply without tables or lists. */
export function sendMessage(id: string, content: string, files: File[] = [], inputMode: "text" | "voice" = "text", replyStyle: "text" | "spoken" = "text") {
  const form = new FormData();
  form.append("content", content);
  form.append("input_mode", inputMode);
  if (replyStyle === "spoken") form.append("reply_style", "spoken");
  for (const file of files) form.append("files", file, file.name);
  return request<{ message: Message; reply: Message | null }>(`/api/conversations/${id}/messages`, { method: "POST", body: form });
}

export const attachmentUrl = (id: string) => `/api/attachments/${id}`;

export function fetchTasks(
  params: { department?: string; status?: string; conversation_id?: string; workflow_id?: string; assignee_id?: string; kind?: string } = {},
) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
  return request<Task[]>(`/api/tasks${query.size ? `?${query}` : ""}`);
}

export interface TaskDraft {
  title: string;
  description: string;
  department: string;
  assignee_id: string | null;
  source_conversation_id?: string | null;
  source_message_id?: number | null;
}

export const createTask = (draft: TaskDraft) => request<Task>("/api/tasks", { method: "POST", body: JSON.stringify(draft) });
export const updateTask = (id: string, changes: Partial<Pick<Task, "title" | "description" | "assignee_id" | "status">>) =>
  request<Task>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(changes) });

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** First non-empty line of a message, trimmed to a task-sized title. */
export function taskTitleFrom(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
    .find(Boolean);
  if (!line) return "";
  return line.length <= 120 ? line : `${line.slice(0, 117).trimEnd()}…`;
}
