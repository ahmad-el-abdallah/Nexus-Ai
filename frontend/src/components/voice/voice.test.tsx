import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { micError, micSupport } from "@/lib/recorder";
import { speechPlayer } from "@/lib/speech";
import { formatSize, installed, transcribe, type VoiceModel, type VoiceOverview } from "@/lib/voice";
import { useVoiceStore } from "@/world/state/voiceStore";

import { MicButton } from "./MicButton";
import { VoiceSettingsPage } from "./VoiceSettingsPage";

const model = (over: Partial<VoiceModel>): VoiceModel => ({
  id: "whisper-base",
  kind: "stt",
  label: "Whisper base (faster-whisper)",
  languages: ["multilingual"],
  size: 147_883_000,
  license: "MIT",
  source: "https://huggingface.co/Systran/faster-whisper-base",
  description: "Fast speech recognition.",
  speakers: 1,
  state: "not_installed",
  downloaded: null,
  error: null,
  loaded: false,
  ...over,
});

const overview = (models: VoiceModel[]): VoiceOverview => ({
  engine: "local",
  settings: { stt_model: "whisper-base", language: "auto", speak_replies: false, muted: false, speech_rate: 1 },
  models,
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const initialVoice = useVoiceStore.getState();

beforeEach(() => {
  useVoiceStore.setState(initialVoice, true);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  speechPlayer.stop();
});

describe("microphone errors", () => {
  it("explains every getUserMedia failure in plain language", () => {
    expect(micError(new DOMException("x", "NotAllowedError"))).toMatchObject({ kind: "denied", message: expect.stringContaining("Microphone access is blocked") });
    expect(micError(new DOMException("x", "NotFoundError"))).toMatchObject({ kind: "no_device", message: expect.stringContaining("No microphone was found") });
    expect(micError(new DOMException("x", "NotReadableError"))).toMatchObject({ kind: "busy" });
    expect(micError(new Error("weird"))).toMatchObject({ kind: "failed" });
  });

  it("refuses insecure pages and browsers without recording support", () => {
    vi.stubGlobal("isSecureContext", false);
    expect(micSupport()).toMatchObject({ kind: "insecure", message: expect.stringContaining("http://localhost") });
    vi.stubGlobal("isSecureContext", true);
    expect(micSupport()).toMatchObject({ kind: "unsupported" }); // jsdom has no MediaRecorder
  });
});

describe("voice client", () => {
  it("uploads recordings as multipart with the language", async () => {
    const fetchMock = vi.fn(async () => json({ text: "hi", language: "en", language_probability: 1, duration_s: 1, processing_ms: 900, model: "whisper-base" }));
    vi.stubGlobal("fetch", fetchMock);
    await transcribe(new Blob(["x"], { type: "audio/webm" }), "ar");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/voice/transcribe");
    const form = init.body as FormData;
    expect((form.get("audio") as File).name).toBe("recording.webm");
    expect(form.get("language")).toBe("ar");
  });

  it("knows what is installed", () => {
    const o = overview([model({ state: "installed" }), model({ id: "piper-ar", kind: "tts", languages: ["ar"], state: "installed" })]);
    expect(installed(o, "stt")).toBe(true);
    expect(installed(o, "tts", "ar")).toBe(true);
    expect(installed(o, "tts", "en")).toBe(false);
    expect(installed(null, "stt")).toBe(false);
    expect(formatSize(147_883_000)).toBe("148 MB");
  });
});

describe("speech player", () => {
  it("plays the reply part by part and stops cleanly", async () => {
    const played: string[] = [];
    class FakeAudio {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly src: string) {}
      play() {
        played.push(this.src);
        setTimeout(() => this.onended?.(), 0);
        return Promise.resolve();
      }
      pause() {}
    }
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("URL", { ...URL, createObjectURL: (b: Blob) => `blob:${(b as Blob).size}`, revokeObjectURL: () => {} });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/speech")) return json({ message_id: 7, employee_id: "e1", speaker: 3, parts: [{ text: "One.", language: "en" }, { text: "اثنان.", language: "ar" }] });
      const body = JSON.parse(init!.body as string);
      return new Response(body.text, { headers: { "content-type": "audio/wav" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const states: string[] = [];
    const off = speechPlayer.subscribe((s) => states.push(s.status));
    await speechPlayer.play(7);
    off();
    expect(speechPlayer.state.error).toBeNull();
    expect(played).toHaveLength(2);
    const bodies = fetchMock.mock.calls.slice(1).map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(bodies).toEqual([
      { text: "One.", language: "en", employee_id: "e1" },
      { text: "اثنان.", language: "ar", employee_id: "e1" },
    ]);
    expect(states[0]).toBe("loading");
    expect(states).toContain("speaking");
    expect(states.at(-1)).toBe("idle");
  });

  it("reports speech errors instead of failing silently", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/speech")
          ? json({ message_id: 7, employee_id: null, speaker: null, parts: [{ text: "Hi.", language: "en" }] })
          : json({ detail: { kind: "not_installed", message: "The English voice isn't installed." } }, 409),
      ),
    );
    await speechPlayer.play(7);
    expect(speechPlayer.state).toMatchObject({ status: "idle", error: "The English voice isn't installed." });
  });
});

describe("MicButton", () => {
  it("shows recording time and level, and stops on click", () => {
    const onStop = vi.fn();
    render(<MicButton phase="recording" level={0.5} elapsed="0:03" onStart={() => {}} onStop={onStop} />);
    const button = screen.getByRole("button", { name: "Stop recording and transcribe" });
    expect(button).toHaveTextContent("0:03");
    fireEvent.click(button);
    expect(onStop).toHaveBeenCalled();
  });

  it("is disabled while transcribing", () => {
    render(<MicButton phase="transcribing" level={0} elapsed="0:00" onStart={() => {}} onStop={() => {}} />);
    expect(screen.getByRole("button", { name: "Transcribing" })).toBeDisabled();
  });
});

describe("VoiceSettingsPage", () => {
  it("shows sizes, licences and real states, and installs on request", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/voice/models/whisper-base/install" && init?.method === "POST")
        return json(overview([model({ state: "downloading", downloaded: 73_941_500 })]), 202);
      return json(overview([model({}), model({ id: "piper-en", kind: "tts", label: "Piper English", languages: ["en"], state: "installed", license: "CC BY 4.0" })]));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<VoiceSettingsPage />);
    const card = await screen.findByText("Whisper base (faster-whisper)").then((el) => el.closest("li")!);
    expect(card).toHaveTextContent("148 MB · MIT");
    expect(card).toHaveTextContent("Not installed");
    expect(screen.getByText("Piper English").closest("li")).toHaveTextContent("Installed");
    expect(screen.getByRole("button", { name: "Test English voice" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Test Arabic voice" })).toBeDisabled();

    fireEvent.click(within(card).getByRole("button", { name: "Install Whisper base (faster-whisper)" }));
    await waitFor(() => expect(screen.getByRole("progressbar", { name: /Downloading Whisper base/ })).toHaveAttribute("aria-valuenow", "50"));
  });

  it("saves preferences through the backend", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push([url, init]);
        const o = overview([model({ state: "installed" })]);
        if (init?.method === "PATCH") o.settings = { ...o.settings, ...JSON.parse(init.body as string) };
        return json(o);
      }),
    );
    render(<VoiceSettingsPage />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Mute all spoken output/ }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Mute all spoken output/ })).toBeChecked());
    const patch = calls.find(([, init]) => init?.method === "PATCH")!;
    expect(patch[0]).toBe("/api/voice/settings");
    expect(JSON.parse(patch[1]!.body as string)).toEqual({ muted: true });
  });
});
