/**
 * Plays agent replies aloud: the backend splits a reply into short parts and
 * synthesises each locally; the next part is fetched while the current one plays.
 */

import { fetchSpeechPlan, speak } from "./voice";

export interface SpeechState {
  messageId: number | null;
  status: "idle" | "loading" | "speaking";
  error: string | null;
}

type Listener = (state: SpeechState) => void;

class SpeechPlayer {
  state: SpeechState = { messageId: null, status: "idle", error: null };
  private listeners = new Set<Listener>();
  private abort: AbortController | null = null;
  private audio: HTMLAudioElement | null = null;
  private urls: string[] = [];

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(state: Partial<SpeechState>) {
    this.state = { ...this.state, ...state };
    for (const l of this.listeners) l(this.state);
  }

  /** Reads one agent message aloud. Resolves when finished or stopped. */
  async play(messageId: number): Promise<void> {
    this.stop();
    const abort = new AbortController();
    this.abort = abort;
    this.set({ messageId, status: "loading", error: null });
    try {
      const plan = await fetchSpeechPlan(messageId);
      if (plan.parts.length === 0) return this.finish(abort);
      const fetchPart = (i: number) => speak(plan.parts[i].text, { language: plan.parts[i].language, employeeId: plan.employee_id }, abort.signal);
      let next = fetchPart(0);
      for (let i = 0; i < plan.parts.length; i++) {
        const blob = await next;
        if (abort.signal.aborted) return;
        if (i + 1 < plan.parts.length) next = fetchPart(i + 1);
        next?.catch(() => {}); // surfaced when awaited
        await this.playBlob(blob, abort.signal);
        if (abort.signal.aborted) return;
      }
      this.finish(abort);
    } catch (error) {
      if (abort.signal.aborted) return;
      const name = (error as Error).name;
      this.set({
        messageId: null,
        status: "idle",
        error: name === "NotAllowedError" ? "The browser blocked audio playback. Click “Listen” to play the reply." : (error as Error).message,
      });
    }
  }

  private finish(abort: AbortController) {
    if (this.abort === abort) {
      this.abort = null;
      this.set({ messageId: null, status: "idle" });
    }
  }

  private playBlob(blob: Blob, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      this.urls.push(url);
      const audio = new Audio(url);
      this.audio = audio;
      const done = () => {
        signal.removeEventListener("abort", done);
        resolve();
      };
      audio.onended = done;
      audio.onerror = () => reject(new Error("The reply audio couldn't be played."));
      signal.addEventListener("abort", done);
      this.set({ status: "speaking" });
      audio.play().catch(reject);
    });
  }

  stop() {
    this.abort?.abort();
    this.abort = null;
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    if (this.state.status !== "idle") this.set({ messageId: null, status: "idle" });
  }
}

export const speechPlayer = new SpeechPlayer();
