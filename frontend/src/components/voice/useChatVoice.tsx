"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { Message } from "@/lib/chat";
import type { Employee } from "@/lib/employees";
import { detectWebGL } from "@/lib/webgl";
import type { FaceMode } from "@/world/portrait/TalkingHead";
import { useEmployeeStore } from "@/world/state/employeeStore";
import { speechPlayer, type SpeechState } from "@/lib/speech";
import { installed, type Transcript } from "@/lib/voice";
import { useVoiceStore } from "@/world/state/voiceStore";

import { MicButton, MicLevel } from "./MicButton";
import { useElapsed, useVoiceInput } from "./useVoiceInput";

export interface VoiceDraft {
  file: File;
  transcript: Transcript;
}

// Face to face: send as soon as the owner stops talking (0.8 s of silence).
const HANDS_FREE = { silenceMs: 800, noSpeechMs: 10_000 };

const TalkingHead = dynamic(() => import("@/world/portrait/TalkingHead"), { ssr: false });

/** The employee's face during a voice session: 3D when available, initials otherwise. */
function Face({ employee, mode, big = false, onExpand }: { employee: Employee | null; mode: FaceMode; big?: boolean; onExpand?: () => void }) {
  const [webgl] = useState(() => typeof document !== "undefined" && detectWebGL().webgl2);
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (webgl || mode !== "speaking") return;
    let frame = 0;
    const tick = () => {
      setLevel(speechPlayer.level());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [webgl, mode]);
  const label = { speaking: "Speaking", listening: "Listening", thinking: "Thinking", idle: "" }[mode];
  return (
    <div
      className={`relative shrink-0 overflow-hidden bg-gradient-to-b from-nx-indigo/25 to-nx-bg ${big ? "h-full w-full" : "h-44 w-40 rounded-xl ring-1 ring-nx-cyan/30"}`}
      data-testid={big ? "voice-face-full" : "voice-face"}
      data-mode={mode}
    >
      {employee && webgl ? (
        <TalkingHead employee={employee} mode={mode} level={() => speechPlayer.level()} wide={big} />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2">
          <span className="flex size-16 items-center justify-center rounded-full bg-nx-violet/30 text-lg font-semibold text-white ring-2 ring-nx-cyan/40">
            {(employee?.name ?? "?").split(/\s+/).map((p) => p[0]).slice(0, 2).join("")}
          </span>
          <span className="h-1.5 rounded-full bg-nx-cyan transition-[width] duration-75" style={{ width: `${8 + level * 40}px` }} aria-hidden />
        </div>
      )}
      {!big && (
        <span className="absolute inset-x-0 bottom-0 truncate bg-nx-bg/70 px-2 py-1 text-center text-[11px] text-nx-text">
          {employee?.name ?? "Employee"}
          {label && <span className="text-nx-cyan"> · {label}</span>}
        </span>
      )}
      {onExpand && (
        <button
          type="button"
          onClick={onExpand}
          aria-label="Full screen"
          title="See the employee full screen"
          className="absolute top-1.5 right-1.5 rounded-md bg-nx-bg/70 px-1.5 py-0.5 text-sm text-nx-text ring-1 ring-white/10 hover:bg-nx-bg"
        >
          ⛶
        </button>
      )}
    </div>
  );
}

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
  employee,
  messages,
  text,
  setText,
  submit,
  canSend,
}: {
  conversationId: string | null;
  /** Who answers in this conversation (shown talking in a voice session). */
  employee?: Employee | null;
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
  // Hands-free: the transcript to send as soon as it is in the composer.
  const [auto, setAuto] = useState<{ text: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFullscreen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);
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
      if (session && handsFree && transcript.text.trim()) setAuto({ text: transcript.text });
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

  // Hands-free: send right away, like talking to someone (no countdown).
  const counting = auto !== null && text === auto.text;
  useEffect(() => {
    if (!counting) return;
    const timer = setTimeout(() => {
      setAuto(null);
      submitRef.current();
    }, 0);
    return () => clearTimeout(timer);
  }, [counting]);

  // Current values for callbacks that run after speech finishes.
  const live = useRef({ session, handsFree, micPaused, canSend, start: voice.start, phase: voice.phase });
  useEffect(() => {
    live.current = { session, handsFree, micPaused, canSend, start: voice.start, phase: voice.phase };
  });
  const listenAgain = useCallback(() => {
    const l = live.current;
    if (l.session && l.handsFree && !l.micPaused && l.canSend && l.phase === "idle") void l.start();
  }, []);

  // Read replies aloud while they are being written (sentence by sentence), so the
  // employee starts talking almost at once — only replies seen streaming here.
  const seen = useRef(new Map<number, string>());
  useEffect(() => {
    const wanted = (session || settings?.speak_replies) && !muted && installed(overview, "tts");
    for (const m of messages) {
      const before = seen.current.get(m.id);
      seen.current.set(m.id, m.status);
      if (m.role !== "agent") continue;
      if (m.status === "streaming") {
        if (wanted && m.content) speechPlayer.feed(m.id, m.employee_id, m.content, false);
        continue;
      }
      if (before !== "streaming") continue; // not a reply that just finished here
      if (wanted && m.status === "complete") {
        speechPlayer.feed(m.id, m.employee_id, m.content, true);
        void speechPlayer.whenDone(m.id).then(listenAgain);
      } else {
        if (speechPlayer.state.messageId === m.id) speechPlayer.stop();
        listenAgain();
      }
    }
  }, [messages, session, settings?.speak_replies, muted, overview, listenAgain]);

  // Leaving the conversation ends the session and any speech.
  useEffect(
    () => () => {
      speechPlayer.stop();
    },
    [conversationId],
  );

  /** Files and mode for the message being sent (the draft is kept until it succeeds).
   * In a voice session the reply is spoken, so it is asked for short and plain. */
  const voicePayload = (): { files: File[]; inputMode: "text" | "voice"; replyStyle: "text" | "spoken" } => ({
    ...(draft ? { files: [draft.file], inputMode: "voice" as const } : { files: [], inputMode: "text" as const }),
    replyStyle: session ? "spoken" : "text",
  });
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
    setFullscreen(false);
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
            ? "Sending…"
            : speech.status === "loading"
              ? "Preparing the spoken reply…"
              : speech.status === "speaking"
                ? "Speaking the reply…"
                : micPaused
                  ? "Microphone muted"
                  : "Ready";

  const replying = messages.some((m) => m.status === "streaming");
  const faceMode: FaceMode =
    speech.status === "speaking"
      ? "speaking"
      : voice.phase === "recording"
        ? "listening"
        : voice.phase === "transcribing" || counting || replying || speech.status === "loading"
          ? "thinking"
          : "idle";
  const speaker = useEmployeeStore((s) => s.employees.find((e) => e.id === speech.employeeId)) ?? null;
  const lastAgent = [...messages].reverse().find((m) => m.role === "agent" && m.employee_id);
  const lastSpeaker = useEmployeeStore((s) => s.employees.find((e) => e.id === lastAgent?.employee_id)) ?? null;
  const face = speaker ?? employee ?? lastSpeaker;

  const sessionBar: ReactNode = session && (
    <div className="mb-2 flex items-center gap-3 rounded-xl bg-nx-cyan/[0.06] px-3 py-2 text-xs ring-1 ring-nx-cyan/30" role="region" aria-label="Voice session" data-testid="voice-session">
      {fullscreen ? (
        <div className="flex h-44 w-40 shrink-0 items-center justify-center rounded-xl text-center text-nx-faint ring-1 ring-nx-line">Shown full screen</div>
      ) : (
        <Face employee={face} mode={faceMode} onExpand={() => setFullscreen(true)} />
      )}
      {fullscreen &&
        createPortal(
        <div className="fixed inset-0 z-50 flex flex-col bg-nx-bg" role="dialog" aria-modal="true" aria-label={`Talking with ${face?.name ?? "the employee"}`}>
          <div className="min-h-0 flex-1">
            <Face employee={face} mode={faceMode} big />
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3 border-t border-nx-line bg-nx-bg/90 px-4 py-3 text-sm">
            <span className="font-semibold text-nx-text">{face?.name ?? "Employee"}</span>
            <span className="text-nx-cyan" role="status" aria-live="polite">
              {phaseText}
            </span>
            {voice.phase === "recording" && <MicLevel level={voice.level} />}
            {voice.phase === "recording" ? (
              <button type="button" onClick={() => void voice.stop()} className="rounded-lg px-3 py-1.5 text-nx-text ring-1 ring-nx-line-strong hover:bg-white/5">
                Done talking
              </button>
            ) : (
              <button type="button" disabled={!canSend || voice.phase !== "idle" || micPaused} onClick={() => (sttReady ? startTalking() : setNotice("not_installed"))} className="rounded-lg px-3 py-1.5 text-nx-text ring-1 ring-nx-line-strong hover:bg-white/5 disabled:opacity-40">
                Talk
              </button>
            )}
            {speech.status !== "idle" && (
              <button type="button" onClick={() => speechPlayer.stop()} className="rounded-lg px-3 py-1.5 text-nx-text ring-1 ring-nx-line-strong hover:bg-white/5">
                Stop speaking
              </button>
            )}
            <button type="button" onClick={() => setFullscreen(false)} className="rounded-lg px-3 py-1.5 text-nx-text ring-1 ring-nx-line-strong hover:bg-white/5">
              Exit full screen
            </button>
            <button type="button" onClick={endSession} className="rounded-lg px-3 py-1.5 text-nx-warn ring-1 ring-nx-warn/50 hover:bg-nx-warn/10">
              End
            </button>
          </div>
        </div>,
          document.body,
        )}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-nx-cyan">Voice session</span>
          <span className="text-nx-muted" role="status" aria-live="polite">
            {phaseText}
          </span>
          {voice.phase === "recording" && <MicLevel level={voice.level} />}
        </div>
        <span className="flex flex-wrap gap-1.5">
        {voice.phase === "recording" ? (
          <button type="button" onClick={() => void voice.stop()} className="rounded-lg px-2.5 py-1 text-nx-text ring-1 ring-nx-line-strong hover:bg-white/5">
            Done talking
          </button>
        ) : (
          <button type="button" disabled={!canSend || voice.phase !== "idle" || micPaused} onClick={() => (sttReady ? startTalking() : setNotice("not_installed"))} className="rounded-lg px-2.5 py-1 text-nx-text ring-1 ring-nx-line-strong hover:bg-white/5 disabled:opacity-40">
            Talk
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
