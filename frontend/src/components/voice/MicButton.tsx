"use client";

import type { VoicePhase } from "./useVoiceInput";

/** Live input level (0..1) as five bars. */
export function MicLevel({ level }: { level: number }) {
  return (
    <span className="inline-flex h-4 items-end gap-0.5" aria-hidden data-testid="mic-level">
      {[0.1, 0.25, 0.45, 0.65, 0.85].map((t) => (
        <span key={t} className={`w-1 rounded-sm transition-all ${level > t ? "bg-nx-cyan" : "bg-white/15"}`} style={{ height: `${30 + t * 70}%` }} />
      ))}
    </span>
  );
}

export function MicButton({
  phase,
  level,
  elapsed,
  disabled,
  onStart,
  onStop,
}: {
  phase: VoicePhase;
  level: number;
  elapsed: string;
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  if (phase === "recording") {
    return (
      <button
        type="button"
        onClick={onStop}
        aria-label="Stop recording and transcribe"
        className="flex h-10 shrink-0 items-center gap-2 rounded-lg bg-nx-error/15 px-3 text-xs font-semibold text-nx-error ring-1 ring-nx-error/50 hover:bg-nx-error/25"
      >
        <span className="nx-pulse size-2 rounded-full bg-nx-error" />
        {elapsed}
        <MicLevel level={level} />
      </button>
    );
  }
  const busy = phase === "starting" || phase === "transcribing";
  return (
    <button
      type="button"
      onClick={onStart}
      disabled={disabled || busy}
      aria-label={phase === "transcribing" ? "Transcribing" : "Record a voice message"}
      title="Record a voice message (transcribed on this computer)"
      className="h-10 shrink-0 rounded-lg px-3 text-sm text-nx-muted ring-1 ring-nx-line-strong hover:text-nx-text disabled:opacity-50"
    >
      {phase === "transcribing" ? <span className="text-xs">Transcribing…</span> : <span aria-hidden>🎙️</span>}
    </button>
  );
}
