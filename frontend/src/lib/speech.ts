/**
 * Plays agent replies aloud. Two ways:
 *  - `play(id)`: a finished reply; the backend splits it into parts and synthesises
 *    each locally, the next part fetched while the current one plays.
 *  - `feed(id, …)`: a reply that is still being written (voice sessions). Each
 *    finished sentence is spoken as soon as it arrives, like talking face to face.
 * While audio plays, `level()` follows its loudness so a face can move its mouth.
 */

import { fetchSpeechPlan, speak } from "./voice";

export interface SpeechState {
  messageId: number | null;
  employeeId: string | null;
  status: "idle" | "loading" | "speaking";
  error: string | null;
}

type Listener = (state: SpeechState) => void;

// ------------------------------------------------------------ sentence split

const FIRST_MIN = 12; // start talking after the first short sentence
const NEXT_MIN = 25; // then speak in slightly longer pieces
const BOUNDARY = /[.!?؟…]+["'”’)\]]*(?=\s)|\n+/g;

/**
 * Splits text that is still growing into pieces ready to be spoken. Returns the
 * pieces and how many characters they used; the rest waits for more text (or is
 * flushed when `final`). Unfinished code blocks are never spoken half-way.
 */
export function takeSpeakable(text: string, final: boolean, first: boolean): { parts: string[]; used: number } {
  let limit = text.length;
  const fences = [...text.matchAll(/```/g)];
  if (fences.length % 2 === 1) limit = fences[fences.length - 1].index ?? limit;
  const parts: string[] = [];
  let start = 0;
  let used = 0;
  BOUNDARY.lastIndex = 0;
  for (let match = BOUNDARY.exec(text); match && match.index < limit; match = BOUNDARY.exec(text)) {
    const end = match.index + match[0].length;
    const piece = text.slice(start, end).trim();
    const min = parts.length === 0 && first ? FIRST_MIN : NEXT_MIN;
    if (piece.length >= min) {
      parts.push(piece);
      start = end;
      used = end;
    }
  }
  if (final && fences.length % 2 === 0) {
    const rest = text.slice(start).trim();
    if (rest) parts.push(rest);
    used = text.length;
  }
  return { parts, used };
}

// ------------------------------------------------------------ mouth movement

export interface Envelope {
  perSecond: number;
  values: Float32Array;
}

/** Loudness of a 16-bit PCM WAV over time (0…1), for moving a mouth with the voice. */
export function wavEnvelope(data: ArrayBuffer, windowMs = 25): Envelope | null {
  const view = new DataView(data);
  if (data.byteLength < 44 || view.getUint32(0, false) !== 0x52494646) return null; // "RIFF"
  let offset = 12;
  let rate = 0;
  let channels = 1;
  let bits = 16;
  while (offset + 8 <= data.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 0x666d7420) {
      // "fmt "
      channels = view.getUint16(body + 2, true);
      rate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 0x64617461 && rate && bits === 16) {
      // "data"
      const frames = Math.floor(Math.min(size, data.byteLength - body) / (2 * channels));
      const window = Math.max(1, Math.round((rate * windowMs) / 1000));
      const values = new Float32Array(Math.ceil(frames / window));
      let peak = 0;
      for (let w = 0; w < values.length; w++) {
        let sum = 0;
        const from = w * window;
        const to = Math.min(frames, from + window);
        for (let f = from; f < to; f++) {
          const v = view.getInt16(body + f * 2 * channels, true) / 32768;
          sum += v * v;
        }
        values[w] = Math.sqrt(sum / Math.max(1, to - from));
        peak = Math.max(peak, values[w]);
      }
      if (peak > 0) for (let w = 0; w < values.length; w++) values[w] = Math.min(1, Math.sqrt(values[w] / (peak * 0.8)));
      return { perSecond: 1000 / windowMs, values };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

// ------------------------------------------------------------------- player

interface Stream {
  messageId: number;
  employeeId: string | null;
  abort: AbortController;
  offset: number;
  final: boolean;
  parts: Promise<Blob | null>[];
  wake: (() => void) | null;
  done: Promise<void>;
}

class SpeechPlayer {
  state: SpeechState = { messageId: null, employeeId: null, status: "idle", error: null };
  private listeners = new Set<Listener>();
  private abort: AbortController | null = null;
  private audio: HTMLAudioElement | null = null;
  private envelope: Envelope | null = null;
  private urls: string[] = [];
  private stream: Stream | null = null;

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

  /** How loud the voice is right now (0…1); 0 when nothing is playing. */
  level(): number {
    const audio = this.audio;
    const envelope = this.envelope;
    if (!audio || !envelope || audio.paused) return 0;
    return envelope.values[Math.floor(audio.currentTime * envelope.perSecond)] ?? 0;
  }

  /** Reads one finished agent message aloud. Resolves when finished or stopped. */
  async play(messageId: number): Promise<void> {
    this.stop();
    const abort = new AbortController();
    this.abort = abort;
    this.set({ messageId, employeeId: null, status: "loading", error: null });
    try {
      const plan = await fetchSpeechPlan(messageId);
      this.set({ employeeId: plan.employee_id });
      if (plan.parts.length === 0) return this.finish(abort);
      const fetchPart = (i: number) => speak(plan.parts[i].text, { language: plan.parts[i].language, employeeId: plan.employee_id }, abort.signal);
      let next = fetchPart(0);
      for (let i = 0; i < plan.parts.length; i++) {
        const blob = await next;
        if (abort.signal.aborted) return;
        if (i + 1 < plan.parts.length) next = fetchPart(i + 1);
        next?.catch(() => {}); // surfaced when awaited
        if (blob) await this.playBlob(blob, abort.signal);
        if (abort.signal.aborted) return;
      }
      this.finish(abort);
    } catch (error) {
      this.fail(abort, error);
    }
  }

  /**
   * Speaks a reply while it is being written: call with the full text so far each
   * time it grows, and once more with `final` when it is complete.
   */
  feed(messageId: number, employeeId: string | null, text: string, final: boolean): void {
    let s = this.stream;
    if (!s || s.messageId !== messageId) {
      this.stop();
      const abort = new AbortController();
      this.abort = abort;
      let finished!: () => void;
      s = { messageId, employeeId, abort, offset: 0, final: false, parts: [], wake: null, done: new Promise((r) => (finished = r)) };
      this.stream = s;
      this.set({ messageId, employeeId, status: "loading", error: null });
      void this.runStream(s).finally(() => finished());
    }
    if (s.final) return;
    const { parts, used } = takeSpeakable(text.slice(s.offset), final, s.offset === 0);
    s.offset += used;
    s.final = final;
    for (const part of parts) {
      const blob = speak(part, { employeeId: s.employeeId, clean: true }, s.abort.signal);
      blob.catch(() => {}); // surfaced when awaited
      s.parts.push(blob);
    }
    s.wake?.();
  }

  /** Resolves when the given message has been spoken (or speech stopped). */
  whenDone(messageId: number): Promise<void> {
    return this.stream?.messageId === messageId ? this.stream.done : Promise.resolve();
  }

  private async runStream(s: Stream): Promise<void> {
    try {
      for (let i = 0; ; i++) {
        while (i >= s.parts.length && !s.final && !s.abort.signal.aborted) {
          await new Promise<void>((resolve) => {
            s.wake = resolve;
            s.abort.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          s.wake = null;
        }
        if (s.abort.signal.aborted || i >= s.parts.length) break;
        const blob = await s.parts[i];
        if (s.abort.signal.aborted) break;
        if (blob) await this.playBlob(blob, s.abort.signal);
        if (s.abort.signal.aborted) break;
        if (i + 1 >= s.parts.length && !s.final) this.set({ status: "loading" });
      }
      if (!s.abort.signal.aborted) this.finish(s.abort);
    } catch (error) {
      this.fail(s.abort, error);
    } finally {
      if (this.stream === s) this.stream = null;
    }
  }

  private finish(abort: AbortController) {
    if (this.abort === abort) {
      this.abort = null;
      this.set({ messageId: null, employeeId: null, status: "idle" });
    }
  }

  private fail(abort: AbortController, error: unknown) {
    if (abort.signal.aborted) return;
    const name = (error as Error).name;
    this.abort = null;
    this.set({
      messageId: null,
      employeeId: null,
      status: "idle",
      error: name === "NotAllowedError" ? "The browser blocked audio playback. Click “Listen” to play the reply." : (error as Error).message,
    });
  }

  private async playBlob(blob: Blob, signal: AbortSignal): Promise<void> {
    this.envelope = wavEnvelope(await blob.arrayBuffer().catch(() => new ArrayBuffer(0)));
    if (signal.aborted) return;
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
    this.stream?.wake?.();
    this.stream = null;
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
    this.envelope = null;
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    if (this.state.status !== "idle") this.set({ messageId: null, employeeId: null, status: "idle" });
  }
}

export const speechPlayer = new SpeechPlayer();
