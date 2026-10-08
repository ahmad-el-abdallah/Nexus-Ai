/** Client for company email (`/api/email`): accounts, approval queue, sending, inbox, log. */

import { request } from "./employees";

export type Security = "ssl" | "starttls" | "none";
export type AccountStatus = "untested" | "connected" | "needs_auth" | "error" | "disconnected";

export interface EmailProvider {
  key: string;
  label: string;
  smtp_host: string;
  smtp_port: number;
  smtp_security: Security;
  imap_host: string | null;
  imap_port: number | null;
  imap_security: Security | null;
  oauth: "google" | "microsoft" | null;
  oauth_needs_secret: boolean;
  /** Sends through an HTTP API with an API key ("brevo") instead of SMTP. */
  api: string | null;
  note: string;
}

export interface EmailAccount {
  id: string;
  label: string;
  provider: string;
  provider_label: string;
  auth_method: "password" | "oauth" | "api_key";
  address: string;
  display_name: string;
  username: string;
  smtp_host: string;
  smtp_port: number;
  smtp_security: Security;
  imap_host: string | null;
  imap_port: number | null;
  imap_security: Security | null;
  status: AccountStatus;
  status_detail: string | null;
  is_default: boolean;
  has_secret: boolean;
  oauth_client_saved: boolean;
  last_test_at: string | null;
  last_test_ok: boolean | null;
  last_sync_at: string | null;
  created_at: string | null;
}

export interface AccountsResponse {
  accounts: EmailAccount[];
  secret_key_present: boolean;
  oauth_redirect_uri: string;
}

export interface TestResult {
  ok: boolean;
  steps: { name: string; ok: boolean; detail: string }[];
}

export type MessageStatus =
  | "drafting"
  | "draft_failed"
  | "pending_approval"
  | "approved"
  | "sending"
  | "sent"
  | "failed"
  | "uncertain"
  | "rejected"
  | "received";

export interface EmailMessage {
  id: string;
  account_id: string | null;
  account_address: string;
  direction: "outbound" | "inbound";
  status: MessageStatus;
  message_id_header: string;
  in_reply_to: string | null;
  from_address: string;
  from_name: string | null;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  attachments: string[];
  received_at: string | null;
  drafted_by_employee_id: string | null;
  drafted_by_name: string | null;
  instructions: string | null;
  model: string | null;
  reply_to_id: string | null;
  approved_at: string | null;
  rejected_reason: string | null;
  send_attempts: number;
  last_error: string | null;
  sent_at: string | null;
  server_response: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** Received from outside the company: shown as plain text, never obeyed. */
  untrusted: boolean;
}

export interface EmailLogEntry {
  id: number;
  created_at: string | null;
  account_id: string | null;
  message_id: string | null;
  level: "info" | "warn" | "error";
  kind: string;
  text: string;
}

export type Folder = "approval" | "inbox" | "outbox" | "sent" | "rejected";

export const FOLDERS: { key: Folder; label: string; hint: string }[] = [
  { key: "approval", label: "Approval queue", hint: "Drafts waiting for you. Nothing is sent until you approve it." },
  { key: "inbox", label: "Inbox", hint: "Received mail, read-only. It comes from outside the company and is treated as untrusted." },
  { key: "outbox", label: "Outbox", hint: "Approved mail being sent, and sends that failed or need your attention." },
  { key: "sent", label: "Sent", hint: "Mail the server accepted." },
  { key: "rejected", label: "Rejected", hint: "Drafts you declined (kept for the record)." },
];

export const STATUS_TEXT: Record<MessageStatus, string> = {
  drafting: "Being written",
  draft_failed: "Draft failed",
  pending_approval: "Waiting for approval",
  approved: "Approved · queued",
  sending: "Sending…",
  sent: "Sent",
  failed: "Not sent",
  uncertain: "Outcome uncertain",
  rejected: "Rejected",
  received: "Received",
};

export type Tone = "ok" | "warn" | "error" | "neutral" | "info";

export const STATUS_TONE: Record<MessageStatus, Tone> = {
  drafting: "info",
  draft_failed: "error",
  pending_approval: "warn",
  approved: "info",
  sending: "info",
  sent: "ok",
  failed: "error",
  uncertain: "warn",
  rejected: "neutral",
  received: "neutral",
};

export const ACCOUNT_TEXT: Record<AccountStatus, [string, Tone]> = {
  untested: ["Not tested", "neutral"],
  connected: ["Connected", "ok"],
  needs_auth: ["Sign-in needed", "warn"],
  error: ["Connection problem", "error"],
  disconnected: ["Disconnected", "neutral"],
};

export const SECURITY_LABEL: Record<Security, string> = {
  ssl: "SSL/TLS",
  starttls: "STARTTLS",
  none: "None (this computer only)",
};

/** Splits "a@example.com, b@example.org; c@example.net" into addresses. */
export function parseAddresses(text: string): string[] {
  return text
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function sender(m: EmailMessage): string {
  return m.from_name ? `${m.from_name} <${m.from_address}>` : m.from_address;
}

export const fetchProviders = () => request<EmailProvider[]>("/api/email/providers");
export const fetchAccounts = () => request<AccountsResponse>("/api/email/accounts");
export const createAccount = (body: Record<string, unknown>) =>
  request<{ account: EmailAccount; test: TestResult | null }>("/api/email/accounts", { method: "POST", body: JSON.stringify(body) });
export const updateAccount = (id: string, body: Record<string, unknown>) =>
  request<EmailAccount>(`/api/email/accounts/${id}`, { method: "PATCH", body: JSON.stringify(body) });
export const testAccount = (id: string) => request<TestResult>(`/api/email/accounts/${id}/test`, { method: "POST" });
export const syncAccount = (id: string) => request<{ new: number }>(`/api/email/accounts/${id}/sync`, { method: "POST" });
export const disconnectAccount = (id: string, purge = false) =>
  request<void>(`/api/email/accounts/${id}/disconnect`, { method: "POST", body: JSON.stringify({ purge }) });
export const startOAuth = (id: string) => request<{ url: string }>(`/api/email/accounts/${id}/oauth/start`, { method: "POST" });

export const fetchMessages = (folder: Folder, q = "") =>
  request<EmailMessage[]>(`/api/email/messages?folder=${folder}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
export const fetchCounts = () => request<Record<Folder, number>>("/api/email/counts");
export const fetchLog = (limit = 200) => request<EmailLogEntry[]>(`/api/email/log?limit=${limit}`);

export interface DraftBody {
  account_id?: string | null;
  to: string[];
  cc?: string[];
  subject?: string;
  body?: string;
  reply_to_id?: string | null;
}
export const createDraft = (body: DraftBody) => request<EmailMessage>("/api/email/drafts", { method: "POST", body: JSON.stringify(body) });
export const generateDraft = (body: DraftBody & { instructions: string; employee_id?: string | null }) =>
  request<EmailMessage>("/api/email/drafts/generate", { method: "POST", body: JSON.stringify(body) });
export const editDraft = (id: string, body: { to?: string[]; cc?: string[]; subject?: string; body?: string }) =>
  request<EmailMessage>(`/api/email/messages/${id}`, { method: "PATCH", body: JSON.stringify(body) });
export const deleteDraft = (id: string) => request<void>(`/api/email/messages/${id}`, { method: "DELETE" });
export const approveEmail = (id: string) => request<EmailMessage>(`/api/email/messages/${id}/approve`, { method: "POST" });
export const rejectEmail = (id: string, reason = "") =>
  request<EmailMessage>(`/api/email/messages/${id}/reject`, { method: "POST", body: JSON.stringify({ reason }) });
export const redraftEmail = (id: string) => request<EmailMessage>(`/api/email/messages/${id}/redraft`, { method: "POST" });
export const retryEmail = (id: string) => request<EmailMessage>(`/api/email/messages/${id}/retry`, { method: "POST" });
export const verifyEmail = (id: string) => request<{ found: boolean }>(`/api/email/messages/${id}/verify`, { method: "POST" });
export const resendEmail = (id: string) =>
  request<EmailMessage>(`/api/email/messages/${id}/resend`, { method: "POST", body: JSON.stringify({ confirm_possible_duplicate: true }) });
