"use client";

import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import type { Message } from "@/lib/chat";
import { speechPlayer, type SpeechState } from "@/lib/speech";
import { installed, type Transcript } from "@/lib/voice";
import { useVoiceStore } from "@/world/state/voiceStore";

import { MicButton, MicLevel } from "./MicButton";
import { useElapsed, useVoiceInput } from "./useVoiceInput";

export interface VoiceDraft {
  file: File;
  transcript: Transcript;
}

const AUTO_SEND_SECONDS = 3;
const HANDS_FREE = { silenceMs: 1_500, noSpeechMs: 10_000 };

export function useSpeechState(): SpeechState {
  const [state, setState] = useState(speechPlayer.state);
  useEffect(() => speechPlayer.subscribe(setState), []);
  return state;
}

/**
 * Voice for one conversation:
 *  - the mic button records a voice message; the transcript lands in the composer
 *    for review (the recording is attached when sent);
 *  - a voice session reads replies aloud and, hands-free, listens again after
 *    each reply, sending the transcript after a short, cancellable countdown;
 *  - replies are also read aloud outside sessions when "Read replies aloud" is on.
 * Nothing loops on its own: silence or an empty transcript pauses listening.
 */
export function useChatVoice({
  conversationId,
  messages,
  text,
  setText,
  submit,
  canSend,
}: {
  conversationId: string | null;
  messages: Message[];
  text: string;
  setText: (text: string) => void;
  submit: () => void;
  canSend: boolean;
}) {
  const overview = useVoiceStore((s) => s.overview);
  const settings = overview?.settings;
  const muted = settings?.muted ?? false;
  const [draft, setDraft] = useState<VoiceDraft | null>(null);
  const [session, setSession] = useState(false);
  const [handsFree, setHandsFree] = useState(true);
  const [micPaused, setMicPaused] = useState(false);
  // Hands-free auto-send: the transcript it applies to and seconds left.
  const [auto, setAuto] = useState<{ text: string; left: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const speech = useSpeechState();
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  });

  const onResult = useCallback(
    ({ transcript, recording }: { transcript: Transcript; recording: { blob: Blob } }) => {
      const extension = recording.blob.type.includes("ogg") ? "ogg" : recording.blob.type.includes("mp4") ? "m4a" : "webm";
      setDraft({ transcript, file: new File([recording.blob], `voice-message.${extension}`, { type: recording.blob.type || "audio/webm" }) });
      setText(transcript.text);
      setNotice(null);
      if (session && handsFree) setAuto({ text: transcript.text, left: AUTO_SEND_SECONDS });
    },
    [session, handsFree, setText],
  );

  const voice = useVoiceInput({
    language: settings?.language,
    ...(session && handsFree ? HANDS_FREE : {}),
    onResult,
    onNothing: () => setNotice("Didn't hear anything, so listening is paused. Press Talk to speak."),
  });
  const elapsed = useElapsed(voice.startedAt);

  // Auto-send countdown (hands-free); typing or editing the transcript cancels it.
  const counting = auto !== null && text === auto.text;
  useEffect(() => {
    if (!counting || !auto) return;
    const timer = setTimeout(() => {
      if (auto.left <= 1) {
        setAuto(null);
        submitRef.current();
      } else {
        setAuto({ ...auto, left: auto.left - 1 });
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [counting, auto]);

  // Current values for callbacks that run after speech finishes.
  const live = useRef({ session, handsFree, micPaused, canSend, start: voice.start, phase: voice.phase });
  useEffect(() => {
    live.current = { session, handsFree, micPaused, canSend, start: voice.start, phase: voice.phase };
  });
  const listenAgain = useCallback(() => {
    const l = live.current;
    if (l.session && l.handsFree && !l.micPaused && l.canSend && l.phase === "idle") void l.start();
  }, []);

  // Read replies aloud when they finish while this conversation is open.
  const seen = useRef(new Map<number, string>());
  useEffect(() => {
    for (const m of messages) {
      const before = seen.current.get(m.id);
      seen.current.set(m.id, m.status);
      if (m.role !== "agent" || before !== "streaming" || m.status !== "complete") continue;
      const wanted = session || settings?.speak_replies;
      const play = wanted && !muted && installed(overview, "tts");
      void (play ? speechPlayer.play(m.id) : Promise.resolve()).then(listenAgain);
    }
  }, [messages, session, settings?.speak_replies, muted, overview, listenAgain]);

  // Leaving the conversation ends the session and any speech.
  useEffect(
    () => () => {
      speechPlayer.stop();
    },
    [conversationId],
  );

  /** Files and mode for the message being sent (the draft is kept until it succeeds). */
  const voicePayload = (): { files: File[]; inputMode: "text" | "voice" } =>
    draft ? { files: [draft.file], inputMode: "voice" } : { files: [], inputMode: "text" };
  const clearDraft = () => {
    setAuto(null);
    setDraft(null);
  };

  const sttReady = installed(overview, "stt");
  const startTalking = () => {
    speechPlayer.stop();
    setNotice(null);
    void voice.start();
  };

  const notInstalled = (
    <span>
      Voice input needs a speech model.{" "}
      <Link href="/settings/voice" className="underline">
        Install one in Settings → Voice
      </Link>
      .
    </span>
  );

  const micButton = (
    <MicButton
      phase={voice.phase}
      level={voice.level}
      elapsed={elapsed}
      disabled={!canSend || !overview}
      onStart={() => (sttReady ? startTalking() : setNotice("not_installed"))}
      onStop={() => void voice.stop()}
    />
  );

  const endSession = () => {
    voice.cancel();
    speechPlayer.stop();
    setAuto(null);
    setSession(false);
    setNotice(null);
  };

  const sessionButton = (
    <button
      type="button"
      onClick={() => (session ? endSession() : (setSession(true), setMicPaused(false), setNotice(null)))}
      aria-pressed={session}
      title={session ? "End voice session" : "Start a voice session: talk, and hear replies"}
      aria-label={session ? "End voice session" : "Start voice session"}
      className={`h-10 shrink-0 rounded-lg px-3 text-sm ring-1 ${session ? "bg-nx-cyan/15 text-nx-cyan ring-nx-cyan/50" : "text-nx-muted ring-nx-line-strong hover:text-nx-text"}`}
    >
      <span aria-hidden>🎧</span>
    </button>
  );

  const phaseText =
    voice.phase === "recording"
      ? `Listening… ${elapsed}`
      : voice.phase === "transcribing"
        ? "Transcribing on this computer…"
        : voice.phase === "starting"
          ? "Opening the microphone…"
          : counting
            ? `Sending in ${auto?.left}… (edit the text to cancel)`
            : speech.status === "loading"
              ? "Preparing the spoken reply…"
              : speech.status === "speaking"
                ? "Speaking the reply…"
                : micPaused
                  ? "Microphone muted"
                  : "Ready";

  const sessionBar: ReactNode = session && (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl bg-nx-cyan/[0.06] px-3 py-2 text-xs ring-1 ring-nx-cyan/30" role="region" aria-label="Voice session" data-testid="voice-session">
      <span className="font-semibold text-nx-cyan">Voice session</span>
      <span className="text-nx-muted" role="status" aria-live="polite">
        {phaseText}
      </span>
      {voice.phase === "recording" && <MicLevel level={voice.level} />}
      <span className="ml-auto flex flex-wrap gap-1.5">
        {voice.phase === "recording" ? (
          <button type="button" onClick={() => void voice.stop()} className="rounded-lg px-2.5 py-1 text-nx-text ring-1 ring-nx-line-strong hover:bg-white/5">
            Done talking
          </button>
        ) : (
          <button type="button" disabled={!canSend || voice.phase !== "idle" || micPaused} onClick={() => (sttReady ? startTalking() : setNotice("not_installed"))} className="rounded-lg px-2.5 py-1 text-nx-text ring-1 ring-nx-line-strong hover:bg-white/5 disabled:opacity-40">
            Talk
          </button>
        )}
        {counting && (
          <button type="button" onClick={() => setAuto(null)} className="rounded-lg px-2.5 py-1 text-nx-text ring-1 ring-nx-line-strong hover:bg-white/5">
            Review first
          </button>
        )}
        {speech.status !== "idle" && (
          <button type="button" onClick={() => speechPlayer.stop()} className="rounded-lg px-2.5 py-1 text-nx-text ring-1 ring-nx-line-strong hover:bg-white/5">
            Stop speaking
          </button>
        )}
        <label className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-nx-muted ring-1 ring-nx-line-strong">
          <input type="checkbox" checked={handsFree} onChange={(e) => setHandsFree(e.target.checked)} />
          Hands-free
        </label>
        <button
          type="button"
          aria-pressed={micPaused}
          onClick={() => {
            if (!micPaused) voice.cancel();
            setMicPaused(!micPaused);
          }}
          className="rounded-lg px-2.5 py-1 text-nx-text ring-1 ring-nx-line-strong hover:bg-white/5"
        >
          {micPaused ? "Unmute mic" : "Mute mic"}
        </button>
        <button
          type="button"
          aria-pressed={muted}
          onClick={() => {
            if (!muted) speechPlayer.stop();
            void useVoiceStore.getState().configure({ muted: !muted });
          }}
          className="rounded-lg px-2.5 py-1 text-nx-text ring-1 ring-nx-line-strong hover:bg-white/5"
        >
          {muted ? "Unmute voice" : "Mute voice"}
        </button>
        <button type="button" onClick={endSession} className="rounded-lg px-2.5 py-1 text-nx-warn ring-1 ring-nx-warn/50 hover:bg-nx-warn/10">
          End
        </button>
      </span>
    </div>
  );

  const errorText = voice.error ?? (notice === "not_installed" ? null : notice);
  const messages_: ReactNode = (
    <>
      {notice === "not_installed" && (
        <p className="mt-2 text-sm text-nx-warn" role="alert">
          {notInstalled}
        </p>
      )}
      {voice.errorKind === "not_installed" ? (
        <p className="mt-2 text-sm text-nx-warn" role="alert">
          {notInstalled}
        </p>
      ) : (
        errorText && (
          <p className={`mt-2 text-sm ${voice.error ? "text-nx-error" : "text-nx-muted"}`} role={voice.error ? "alert" : "status"} data-testid="voice-notice">
            {errorText}
          </p>
        )
      )}
      {speech.error && (
        <p className="mt-2 text-sm text-nx-error" role="alert">
          {speech.error}
        </p>
      )}
    </>
  );

  const draftChip: ReactNode = draft && (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs" data-testid="voice-draft">
      <span className="inline-flex items-center gap-1.5 rounded-lg bg-nx-cyan/10 px-2 py-1 text-nx-cyan ring-1 ring-nx-cyan/30">
        🎙️ Voice message · {draft.transcript.duration_s.toFixed(1)} s · {draft.transcript.language ?? "?"} · transcribed in {(draft.transcript.processing_ms / 1000).toFixed(1)} s
      </span>
      <span className="text-nx-faint">Review the transcript below, then send. The recording is attached.</span>
      <button
        type="button"
        onClick={() => {
          setDraft(null);
          setAuto(null);
        }}
        className="text-nx-faint hover:text-nx-error"
        aria-label="Discard voice recording"
      >
        Discard recording
      </button>
    </div>
  );

  return { micButton, sessionButton, sessionBar, draftChip, messages: messages_, voicePayload, clearDraft, session, speech };
}
