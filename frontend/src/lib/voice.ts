/** Client for local voice features (`/api/voice`). Audio is processed on this computer. */

import { ApiError, request } from "./employees";

export type VoiceLanguage = "auto" | "en" | "ar";

export interface VoiceSettings {
  stt_model: string;
  language: VoiceLanguage;
  speak_replies: boolean;
  muted: boolean;
  speech_rate: number;
}

export interface VoiceModel {
  id: string;
  kind: "stt" | "tts";
  label: string;
  languages: string[];
  size: number;
  license: string;
  source: string;
  description: string;
  speakers: number;
  state: "installed" | "downloading" | "not_installed" | "error";
  downloaded: number | null;
  error: string | null;
  loaded: boolean;
}

export interface VoiceOverview {
  engine: string;
  settings: VoiceSettings;
  models: VoiceModel[];
}

export interface Transcript {
  text: string;
  language: string | null;
  language_probability: number | null;
  duration_s: number;
  processing_ms: number;
  model: string;
}

export interface SpeechPlan {
  message_id: number;
  employee_id: string | null;
  speaker: number | null;
  parts: { text: string; language: "en" | "ar" }[];
}

export const fetchVoice = () => request<VoiceOverview>("/api/voice");
export const updateVoiceSettings = (changes: Partial<VoiceSettings>) =>
  request<VoiceOverview>("/api/voice/settings", { method: "PATCH", body: JSON.stringify(changes) });
export const installVoiceModel = (id: string) => request<VoiceOverview>(`/api/voice/models/${id}/install`, { method: "POST" });
export const removeVoiceModel = (id: string) => request<VoiceOverview>(`/api/voice/models/${id}`, { method: "DELETE" });
export const fetchSpeechPlan = (messageId: number) => request<SpeechPlan>(`/api/voice/messages/${messageId}/speech`);

export function transcribe(audio: Blob, language?: VoiceLanguage) {
  const form = new FormData();
  form.append("audio", audio, audio.type.includes("ogg") ? "recording.ogg" : audio.type.includes("wav") ? "recording.wav" : "recording.webm");
  if (language) form.append("language", language);
  return request<Transcript>("/api/voice/transcribe", { method: "POST", body: form });
}

/**
 * Text → WAV, synthesised locally in the employee's voice. `clean`: the text is a
 * piece of a streaming reply (Markdown removed server-side); null when there is
 * nothing worth saying in it.
 */
export async function speak(text: string, opts: { language?: "en" | "ar"; employeeId?: string | null; clean?: boolean } = {}, signal?: AbortSignal): Promise<Blob | null> {
  const response = await fetch("/api/voice/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, language: opts.language, employee_id: opts.employeeId ?? undefined, clean: opts.clean || undefined }),
    signal,
  });
  if (!response.ok) {
    let message = `Speech failed (${response.status})`;
    try {
      const body = await response.json();
      message = body?.detail?.message ?? body?.detail ?? message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return null;
  return response.blob();
}

export const installed = (overview: VoiceOverview | null, kind: "stt" | "tts", language?: string) =>
  Boolean(overview?.models.some((m) => m.kind === kind && m.state === "installed" && (!language || m.languages.includes(language))));

export function formatSize(bytes: number) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}
