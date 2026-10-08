"use client";

import { useEffect, useState } from "react";

import { AppShell } from "@/components/org/AppShell";
import { Badge, ghostBtn, input, labelCls, primaryBtn, Section, SettingsNav } from "@/components/settings/ui";
import { formatSize, speak, type VoiceModel } from "@/lib/voice";
import { useDepartmentStore } from "@/world/state/departmentStore";
import { useEmployeeStore } from "@/world/state/employeeStore";
import { startVoiceSync, useVoiceStore } from "@/world/state/voiceStore";

import { MicLevel } from "./MicButton";
import { useElapsed, useVoiceInput, type VoiceResult } from "./useVoiceInput";

function stateBadge(m: VoiceModel) {
  switch (m.state) {
    case "installed":
      return <Badge tone="ok">Installed{m.loaded ? " · loaded" : ""}</Badge>;
    case "downloading":
      return <Badge tone="info">Downloading {m.downloaded != null ? `${Math.floor((m.downloaded / m.size) * 100)}%` : ""}</Badge>;
    case "error":
      return <Badge tone="error">Install failed</Badge>;
    default:
      return <Badge tone="neutral">Not installed</Badge>;
  }
}

function ModelCard({ m, selected, onSelect }: { m: VoiceModel; selected?: boolean; onSelect?: () => void }) {
  const { install, remove } = useVoiceStore.getState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="rounded-xl bg-white/[0.02] p-4 ring-1 ring-nx-line" data-model={m.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-nx-text">{m.label}</p>
          <p className="mt-0.5 text-xs text-nx-faint">
            {formatSize(m.size)} · {m.license} ·{" "}
            <a href={m.source} target="_blank" rel="noreferrer" className="text-nx-indigo hover:text-nx-cyan">
              source ↗
            </a>
          </p>
        </div>
        {stateBadge(m)}
      </div>
      <p className="mt-2 text-xs text-nx-muted">{m.description}</p>
      {m.state === "downloading" && m.downloaded != null && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/5" role="progressbar" aria-valuenow={Math.floor((m.downloaded / m.size) * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`Downloading ${m.label}`}>
          <div className="h-full rounded-full bg-nx-cyan transition-[width]" style={{ width: `${(m.downloaded / m.size) * 100}%` }} />
        </div>
      )}
      {m.error && <p className="mt-2 text-xs text-nx-error">{m.error}</p>}
      {error && (
        <p role="alert" className="mt-2 text-xs text-nx-error">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {m.state === "installed" ? (
          <button type="button" disabled={busy} onClick={() => window.confirm(`Remove ${m.label} (${formatSize(m.size)})? You can install it again later.`) && void act(() => remove(m.id))} className={ghostBtn}>
            Remove
          </button>
        ) : m.state === "downloading" ? (
          <button type="button" disabled={busy} onClick={() => void act(() => remove(m.id))} className={ghostBtn}>
            Cancel download
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => void act(() => install(m.id))} className={primaryBtn} aria-label={`Install ${m.label}`}>
            {m.state === "error" ? "Retry install" : `Install (${formatSize(m.size)})`}
          </button>
        )}
        {onSelect && (
          <label className="ml-auto flex items-center gap-2 text-xs text-nx-muted">
            <input type="radio" name="stt-model" checked={selected} onChange={onSelect} />
            Use for recognition
          </label>
        )}
      </div>
    </li>
  );
}

function MicTest() {
  const [result, setResult] = useState<VoiceResult | null>(null);
  const [permission, setPermission] = useState<string>("unknown");
  const language = useVoiceStore((s) => s.overview?.settings.language);
  const voice = useVoiceInput({ language, onResult: setResult });
  const elapsed = useElapsed(voice.startedAt);

  useEffect(() => {
    let status: PermissionStatus | null = null;
    const update = () => status && setPermission(status.state);
    navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((s) => {
        status = s;
        update();
        s.addEventListener("change", update);
      })
      .catch(() => setPermission("unknown"));
    return () => status?.removeEventListener("change", update);
  }, [voice.phase]);

  const permissionText: Record<string, string> = {
    granted: "Allowed",
    denied: "Blocked — allow it in the browser's site settings",
    prompt: "The browser will ask the first time",
    unknown: "Unknown (this browser doesn't report it)",
  };

  return (
    <Section id="mic-title" title="Microphone test" aside={`Permission: ${permissionText[permission] ?? permission}`}>
      <div className="flex flex-wrap items-center gap-3">
        {voice.phase === "recording" ? (
          <button type="button" onClick={() => void voice.stop()} className={primaryBtn}>
            Stop &amp; transcribe ({elapsed})
          </button>
        ) : (
          <button type="button" disabled={voice.phase !== "idle"} onClick={() => void voice.start()} className={primaryBtn}>
            {voice.phase === "transcribing" ? "Transcribing…" : voice.phase === "starting" ? "Opening microphone…" : "Record a test"}
          </button>
        )}
        {voice.phase === "recording" && <MicLevel level={voice.level} />}
        <p className="text-xs text-nx-faint">Say a sentence in English or Arabic. The audio is transcribed on this computer and not stored.</p>
      </div>
      {voice.error && (
        <p role="alert" className="mt-3 text-sm text-nx-error">
          {voice.error}
        </p>
      )}
      {result && (
        <div className="mt-4 rounded-xl bg-white/[0.03] p-4 ring-1 ring-nx-line" data-testid="mic-test-result">
          <p className="text-sm text-nx-text" dir="auto">
            “{result.transcript.text}”
          </p>
          <p className="mt-2 font-mono text-[11px] text-nx-faint">
            {result.transcript.model} · language {result.transcript.language ?? "—"}
            {result.transcript.language_probability != null ? ` (${Math.round(result.transcript.language_probability * 100)}%)` : ""} · {result.transcript.duration_s.toFixed(1)} s audio ·{" "}
            {result.transcript.processing_ms} ms to transcribe
          </p>
        </div>
      )}
    </Section>
  );
}

function VoiceTest({ models }: { models: VoiceModel[] }) {
  const employees = useEmployeeStore((s) => s.employees);
  const departments = useDepartmentStore((s) => s.departments);
  const ceoId = departments.find((d) => d.key === "executive")?.director_id;
  const [employeeId, setEmployeeId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const who = employees.find((e) => e.id === (employeeId || ceoId));
  const play = async (language: "en" | "ar") => {
    setStatus("Synthesising…");
    try {
      const text =
        language === "ar"
          ? `مرحباً، أنا ${who?.name ?? "موظف"} من نكسس. كيف يمكنني مساعدتك اليوم؟`
          : `Hello, I'm ${who?.name ?? "an employee"}${who ? `, ${who.role}` : ""}. How can I help you today?`;
      const started = performance.now();
      const blob = await speak(text, { language, employeeId: who?.id });
      if (!blob) return;
      const audio = new Audio(URL.createObjectURL(blob));
      await audio.play();
      setStatus(`Synthesised in ${Math.round(performance.now() - started)} ms on this computer.`);
    } catch (err) {
      setStatus((err as Error).message);
    }
  };
  const en = models.some((m) => m.languages.includes("en") && m.kind === "tts" && m.state === "installed");
  const ar = models.some((m) => m.languages.includes("ar") && m.kind === "tts" && m.state === "installed");
  return (
    <div className="mt-4 flex flex-wrap items-end gap-3">
      <label className={labelCls}>
        Voice of
        <select value={employeeId || ceoId || ""} onChange={(e) => setEmployeeId(e.target.value)} className={`${input} w-64`}>
          {[...employees]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} — {e.role}
              </option>
            ))}
        </select>
      </label>
      <button type="button" disabled={!en} onClick={() => void play("en")} className={ghostBtn}>
        Test English voice
      </button>
      <button type="button" disabled={!ar} onClick={() => void play("ar")} className={ghostBtn}>
        Test Arabic voice
      </button>
      {status && (
        <p className="text-xs text-nx-muted" role="status">
          {status}
        </p>
      )}
    </div>
  );
}

function Preferences() {
  const overview = useVoiceStore((s) => s.overview)!;
  const configure = useVoiceStore((s) => s.configure);
  const [error, setError] = useState<string | null>(null);
  const s = overview.settings;
  const save = (changes: Parameters<typeof configure>[0]) => configure(changes).catch((err) => setError((err as Error).message));
  const speed = Math.round((1 / s.speech_rate) * 100) / 100;
  return (
    <Section id="prefs-title" title="Preferences">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className={labelCls}>
          Spoken language
          <select value={s.language} onChange={(e) => void save({ language: e.target.value as typeof s.language })} className={input}>
            <option value="auto">Detect automatically (English, Arabic, …)</option>
            <option value="en">English</option>
            <option value="ar">Arabic — العربية</option>
          </select>
        </label>
        <label className={labelCls}>
          Speaking speed · {speed.toFixed(2)}×
          <input
            type="range"
            min={0.7}
            max={1.5}
            step={0.05}
            value={speed}
            onChange={(e) => void save({ speech_rate: Math.round((1 / Number(e.target.value)) * 100) / 100 })}
            className="mt-3 w-full accent-nx-violet"
          />
        </label>
        <label className="flex items-start gap-3 text-sm text-nx-text">
          <input type="checkbox" checked={s.speak_replies} onChange={(e) => void save({ speak_replies: e.target.checked })} className="mt-1" />
          <span>
            Read replies aloud in chat
            <span className="block text-xs text-nx-faint">Voice sessions always read replies; this also reads them when you type.</span>
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm text-nx-text">
          <input type="checkbox" checked={s.muted} onChange={(e) => void save({ muted: e.target.checked })} className="mt-1" />
          <span>
            Mute all spoken output
            <span className="block text-xs text-nx-faint">Nothing is played aloud, even in voice sessions. Transcription still works.</span>
          </span>
        </label>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-nx-error">
          {error}
        </p>
      )}
    </Section>
  );
}

export function VoiceSettingsPage() {
  const overview = useVoiceStore((s) => s.overview);
  const load = useVoiceStore((s) => s.load);
  const error = useVoiceStore((s) => s.error);
  useEffect(() => startVoiceSync(), []);

  const stt = overview?.models.filter((m) => m.kind === "stt") ?? [];
  const tts = overview?.models.filter((m) => m.kind === "tts") ?? [];
  return (
    <AppShell
      title="Settings"
      subtitle={
        <>
          <strong className="text-nx-text">Voice</strong> runs entirely on this computer: Whisper turns speech into text and Piper speaks replies. Audio never leaves the machine;
          the only download is each model, once, from Hugging Face (pinned version, checked by SHA-256).
        </>
      }
      actions={<SettingsNav current="/settings/voice" />}
    >
      {load === "error" && (
        <p role="alert" className="glass-solid p-4 text-sm text-nx-error">
          Couldn&apos;t load voice settings: {error}
        </p>
      )}
      {overview && (
        <>
          {overview.engine !== "local" && <p className="glass-solid p-3 text-xs text-nx-warn">Engine: {overview.engine}</p>}
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Section id="stt-title" title="Speech recognition (speech → text)" aside="Needed for voice input">
              <ul className="space-y-3">
                {stt.map((m) => (
                  <ModelCard key={m.id} m={m} selected={overview.settings.stt_model === m.id} onSelect={() => void useVoiceStore.getState().configure({ stt_model: m.id })} />
                ))}
              </ul>
            </Section>
            <Section id="tts-title" title="Voices (text → speech)" aside="Needed for spoken replies">
              <ul className="space-y-3">
                {tts.map((m) => (
                  <ModelCard key={m.id} m={m} />
                ))}
              </ul>
              <VoiceTest models={tts} />
            </Section>
          </div>
          <Preferences />
          <MicTest />
        </>
      )}
      {!overview && load !== "error" && <p className="text-sm text-nx-muted">Loading…</p>}
    </AppShell>
  );
}
