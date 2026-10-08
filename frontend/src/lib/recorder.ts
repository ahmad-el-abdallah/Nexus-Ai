/**
 * Microphone recording for voice messages. The microphone is opened only while
 * recording (the browser's indicator shows exactly when) and released after.
 */

export type MicErrorKind = "unsupported" | "insecure" | "denied" | "no_device" | "busy" | "failed";

export class MicError extends Error {
  constructor(
    readonly kind: MicErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "MicError";
  }
}

/** Plain-language explanation for every way getUserMedia can fail. */
export function micError(error: unknown): MicError {
  if (error instanceof MicError) return error;
  const name = (error as { name?: string })?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return new MicError("denied", "Microphone access is blocked. Allow it for this site in the browser's address bar (the lock or mic icon), then try again. You can keep typing meanwhile.");
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return new MicError("no_device", "No microphone was found. Connect one (or check your system sound settings) and try again.");
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return new MicError("busy", "The microphone is in use by another application or couldn't be started.");
    case "SecurityError":
      return new MicError("insecure", "The browser blocked the microphone on this page.");
    default:
      return new MicError("failed", `The microphone couldn't be started${name ? ` (${name})` : ""}.`);
  }
}

export function micSupport(): MicError | null {
  if (typeof window === "undefined") return new MicError("unsupported", "Voice input needs a browser.");
  if (!window.isSecureContext) return new MicError("insecure", "Voice input needs a secure page: open NEXUS AI at http://localhost or over HTTPS.");
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
    return new MicError("unsupported", "This browser can't record audio. Use a current Chrome, Edge or Firefox, or type instead.");
  return null;
}

export interface Recording {
  blob: Blob;
  durationMs: number;
  /** True if the level ever rose above the speech threshold. */
  heardSpeech: boolean;
}

export interface RecorderOptions {
  /** 0..1 input level, ~20 times a second. */
  onLevel?: (level: number) => void;
  /** Stop automatically after this much silence once speech was heard (hands-free). */
  silenceMs?: number | null;
  /** Hands-free: give up if nothing is said for this long. */
  noSpeechMs?: number | null;
  maxMs?: number;
  /** Called when the recorder stops by itself (silence, no speech, time limit). */
  onAutoStop?: (reason: "silence" | "no_speech" | "max") => void;
}

const SPEECH_LEVEL = 0.04;
const SILENCE_LEVEL = 0.02;

function preferredType(): string {
  for (const type of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return "";
}

export class Recorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private context: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private chunks: Blob[] = [];
  private started = 0;
  private heard = false;
  private quietSince = 0;
  private done: Promise<Recording> | null = null;

  constructor(private readonly options: RecorderOptions = {}) {}

  get recording() {
    return this.recorder?.state === "recording";
  }

  async start(): Promise<void> {
    const unsupported = micSupport();
    if (unsupported) throw unsupported;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (error) {
      throw micError(error);
    }
    const type = preferredType();
    const recorder = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined);
    this.recorder = recorder;
    this.chunks = [];
    this.heard = false;
    this.started = Date.now();
    this.quietSince = Date.now();
    this.done = new Promise((resolve) => {
      recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: recorder.mimeType || type || "audio/webm" });
        this.release();
        resolve({ blob, durationMs: Date.now() - this.started, heardSpeech: this.heard });
      };
    });
    recorder.start(250);
    this.monitor();
  }

  private monitor() {
    const { onLevel, silenceMs, noSpeechMs, maxMs = 120_000, onAutoStop } = this.options;
    let analyser: AnalyserNode | null = null;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx && this.stream) {
        this.context = new Ctx();
        analyser = this.context.createAnalyser();
        analyser.fftSize = 1024;
        this.context.createMediaStreamSource(this.stream).connect(analyser);
      }
    } catch {
      analyser = null; // levels are a nicety; recording still works
    }
    const buffer = new Float32Array(1024);
    this.timer = setInterval(() => {
      const now = Date.now();
      let level = 0;
      if (analyser) {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (const v of buffer) sum += v * v;
        level = Math.sqrt(sum / buffer.length);
      }
      onLevel?.(Math.min(1, level * 4));
      if (level > SPEECH_LEVEL) this.heard = true;
      if (level > SILENCE_LEVEL) this.quietSince = now;
      const stopWith = (reason: "silence" | "no_speech" | "max") => {
        if (!this.recording) return;
        this.recorder?.stop();
        onAutoStop?.(reason);
      };
      if (now - this.started >= maxMs) stopWith("max");
      else if (analyser && silenceMs && this.heard && now - this.quietSince >= silenceMs) stopWith("silence");
      else if (analyser && noSpeechMs && !this.heard && now - this.started >= noSpeechMs) stopWith("no_speech");
    }, 50);
  }

  /** Stops and returns the recording (also after an automatic stop). */
  async stop(): Promise<Recording> {
    if (!this.done) throw new MicError("failed", "Not recording.");
    if (this.recording) this.recorder!.stop();
    return this.done;
  }

  cancel() {
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.onstop = () => this.release();
      this.recorder.stop();
    } else {
      this.release();
    }
    this.done = null;
  }

  private release() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.context?.close().catch(() => {});
    this.context = null;
    this.options.onLevel?.(0);
  }
}
