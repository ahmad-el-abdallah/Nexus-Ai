/** Client for the AI gateway (`/api/ai/*`). The API key never comes back from the server. */

import { ApiError, request } from "./employees";

export interface KeyStatus {
  present: boolean;
  source: "app" | "env" | null;
  hint: string | null;
  updated_at: string | null;
  can_save: boolean;
}

export interface AISettings {
  provider: string;
  base_url: string;
  default_model: string | null;
  max_output_tokens: number;
  temperature: number;
  timeout_seconds: number;
  concurrency_limit: number;
  daily_request_budget: number;
  paused: boolean;
  /** Chat and voice: let reasoning models think before answering (slower). */
  chat_thinking: boolean;
  key: KeyStatus;
  last_test: { at: string | null; ok: boolean | null; message: string | null };
}

export type AISettingsPatch = Partial<
  Pick<AISettings, "base_url" | "default_model" | "max_output_tokens" | "temperature" | "timeout_seconds" | "concurrency_limit" | "daily_request_budget" | "paused" | "chat_thinking">
>;

export interface AIModel {
  id: string;
  owned_by: string | null;
  listed: boolean;
  verified_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  last_latency_ms: number | null;
}

export interface TestResult {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; ms: number | null; detail: string }>;
}

export interface RouteInfo {
  employee_id: string;
  model: string | null;
  source: "employee" | "department" | "company default" | null;
}

export interface UsageRow {
  id: number;
  at: string | null;
  model: string | null;
  employee_id: string | null;
  department: string | null;
  purpose: string;
  status: "ok" | "error" | "rejected";
  error_kind: string | null;
  http_status: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  latency_ms: number | null;
  first_token_ms: number | null;
  retries: number;
  streamed: boolean;
}

export interface UsageSummary {
  window_hours: number;
  requests: number;
  ok: number;
  errors: number;
  rejected: number;
  retries: number;
  tokens: { prompt: number; completion: number; reasoning: number };
  latency_ms: { p50: number | null; max: number | null };
  budget: { limit: number; used_24h: number; remaining: number };
  by_model: Array<{ name: string; requests: number; errors: number; tokens: number }>;
  by_department: Array<{ name: string; requests: number; errors: number; tokens: number }>;
  by_error: Array<{ kind: string; count: number }>;
  recent: UsageRow[];
}

const json = (body: unknown) => ({ body: JSON.stringify(body) });

export const getAISettings = () => request<AISettings>("/api/ai/settings");
export const patchAISettings = (patch: AISettingsPatch) => request<AISettings>("/api/ai/settings", { method: "PATCH", ...json(patch) });
export const saveAIKey = (apiKey: string) => request<AISettings>("/api/ai/key", { method: "PUT", ...json({ api_key: apiKey }) });
export const removeAIKey = () => request<AISettings>("/api/ai/key", { method: "DELETE" });
export const testAIConnection = (model?: string) => request<TestResult>("/api/ai/test", { method: "POST", ...json(model ? { model } : {}) });
export const getAIModels = () => request<AIModel[]>("/api/ai/models");
export const refreshAIModels = () => request<{ listed: number }>("/api/ai/models/refresh", { method: "POST" });
export const verifyAIModel = (id: string) => request<AIModel>(`/api/ai/models/${id}/verify`, { method: "POST" });
export const getAIRouting = () => request<RouteInfo[]>("/api/ai/routing");
export const getAIUsage = (hours = 24) => request<UsageSummary>(`/api/ai/usage?hours=${hours}`);

/** Gateway errors arrive as { detail: { kind, message } }. */
export function aiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return (error as Error).message ?? "Request failed";
}

export type StreamEvent =
  | { type: "meta"; model: string; source: string; employee: string | null }
  | { type: "thinking" }
  | { type: "token"; text: string }
  | {
      type: "done";
      finish_reason: string | null;
      prompt_tokens: number | null;
      completion_tokens: number | null;
      reasoning_tokens: number | null;
      first_token_ms: number | null;
      latency_ms: number;
      empty: boolean;
    }
  | { type: "error"; kind: string; message: string };

/** Streams a playground reply (server-sent events over a POST). */
export async function* streamPlayground(
  body: { message: string; employee_id?: string; model?: string; history?: Array<{ role: "user" | "assistant"; content: string }> },
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const response = await fetch("/api/ai/playground", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json();
      message = typeof data.detail === "string" ? data.detail : (data.detail?.message ?? message);
    } catch {
      /* non-JSON error page */
    }
    yield { type: "error", kind: String(response.status), message };
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split: number;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      yield { type: event, ...JSON.parse(data) } as StreamEvent;
    }
  }
}
