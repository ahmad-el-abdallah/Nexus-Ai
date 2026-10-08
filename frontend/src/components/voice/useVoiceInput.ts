"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { MicError, Recorder, type Recording } from "@/lib/recorder";
import { transcribe, type Transcript, type VoiceLanguage } from "@/lib/voice";

export type VoicePhase = "idle" | "starting" | "recording" | "transcribing";

export interface VoiceResult {
  transcript: Transcript;
  recording: Recording;
}

export interface VoiceInputOptions {
  language?: VoiceLanguage;
  /** Hands-free: stop after this much silence once speech was heard. */
  silenceMs?: number | null;
  noSpeechMs?: number | null;
  maxMs?: number;
  /** Called with the transcript after an automatic or manual stop. */
  onResult?: (result: VoiceResult) => void;
  /** Hands-free: nothing was said. */
  onNothing?: () => void;
}

/** Record from the microphone, then transcribe locally. Every failure becomes a readable message. */
export function useVoiceInput(options: VoiceInputOptions = {}) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [level, setLevel] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<string | null>(null);
  const recorder = useRef<Recorder | null>(null);
  const opts = useRef(options);
  useEffect(() => {
    opts.current = options;
  });

  const finish = useCallback(async (rec: Recorder) => {
    let recording: Recording;
    try {
      recording = await rec.stop();
    } catch (err) {
      setPhase("idle");
      setError((err as Error).message);
      return null;
    }
    if (recorder.current === rec) recorder.current = null;
    setStartedAt(null);
    if (recording.durationMs < 400 || recording.blob.size === 0) {
      setPhase("idle");
      if (opts.current.silenceMs) opts.current.onNothing?.();
      else setError("That was too short — hold the mic button a little longer.");
      return null;
    }
    setPhase("transcribing");
    try {
      const transcript = await transcribe(recording.blob, opts.current.language);
      setPhase("idle");
      if (!transcript.text.trim()) {
        if (opts.current.silenceMs) opts.current.onNothing?.();
        else setError("No speech was recognised. Try again closer to the microphone.");
        return null;
      }
      const result = { transcript, recording };
      opts.current.onResult?.(result);
      return result;
    } catch (err) {
      setPhase("idle");
      setError((err as Error).message);
      setErrorKind((err as { status?: number }).status === 409 ? "not_installed" : "transcribe");
      return null;
    }
  }, []);

  const start = useCallback(async () => {
    if (recorder.current) return;
    setError(null);
    setErrorKind(null);
    setPhase("starting");
    const rec = new Recorder({
      onLevel: setLevel,
      silenceMs: opts.current.silenceMs,
      noSpeechMs: opts.current.noSpeechMs,
      maxMs: opts.current.maxMs,
      onAutoStop: () => void finish(rec),
    });
    recorder.current = rec;
    try {
      await rec.start();
      setStartedAt(Date.now());
      setPhase("recording");
    } catch (err) {
      recorder.current = null;
      setPhase("idle");
      setError((err as Error).message);
      setErrorKind(err instanceof MicError ? err.kind : "failed");
    }
  }, [finish]);

  const stop = useCallback(async () => {
    const rec = recorder.current;
    if (!rec) return null;
    return finish(rec);
  }, [finish]);

  const cancel = useCallback(() => {
    recorder.current?.cancel();
    recorder.current = null;
    setStartedAt(null);
    setPhase("idle");
  }, []);

  useEffect(() => () => recorder.current?.cancel(), []);

  return { phase, level, startedAt, error, errorKind, start, stop, cancel, clearError: () => setError(null) };
}

export function useElapsed(startedAt: number | null) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (!startedAt || now < startedAt) return "0:00";
  const s = Math.floor((now - startedAt) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
