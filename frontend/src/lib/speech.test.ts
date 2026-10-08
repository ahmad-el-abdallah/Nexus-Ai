import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessage } from "./chat";
import { takeSpeakable, wavEnvelope } from "./speech";

function wav(samples: number[], rate = 22_050): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => view.setInt16(44 + i * 2, v, true));
  return buffer;
}

afterEach(() => vi.unstubAllGlobals());

describe("speaking a reply while it is written", () => {
  it("starts with the first finished sentence and keeps the rest for later", () => {
    const first = takeSpeakable("Hi there, nice to see you. Our team is", false, true);
    expect(first.parts).toEqual(["Hi there, nice to see you."]);
    const rest = "Hi there, nice to see you. Our team is".slice(first.used);
    expect(takeSpeakable(rest, false, false).parts).toEqual([]); // not finished yet
    expect(takeSpeakable(rest, true, false).parts).toEqual(["Our team is"]); // flushed at the end
  });

  it("joins very short sentences and handles Arabic punctuation and new lines", () => {
    const { parts } = takeSpeakable("Yes. Of course. We can start on Monday with the whole marketing team ready.\nفريق المبيعات جاهز تماماً للعمل؟ ", false, false);
    expect(parts).toEqual(["Yes. Of course. We can start on Monday with the whole marketing team ready.", "فريق المبيعات جاهز تماماً للعمل؟"]);
  });

  it("never speaks half of an unfinished code block", () => {
    const text = "Here is the idea. ```\nconst a = 1. ";
    expect(takeSpeakable(text, false, true).parts).toEqual(["Here is the idea."]);
    expect(takeSpeakable(text, true, true).used).toBeLessThan(text.length);
  });
});

describe("mouth movement", () => {
  it("follows the loudness of the voice", () => {
    const quiet = Array.from({ length: 2205 }, () => 0);
    const loud = Array.from({ length: 2205 }, (_, i) => Math.round(Math.sin(i / 5) * 20000));
    const env = wavEnvelope(wav([...quiet, ...loud]))!;
    expect(env.perSecond).toBe(40);
    expect(env.values[0]).toBe(0);
    expect(env.values[env.values.length - 1]).toBeGreaterThan(0.8);
    expect(wavEnvelope(new ArrayBuffer(10))).toBeNull();
  });
});

describe("voice sessions", () => {
  it("ask for a spoken reply (short, no tables)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: {}, reply: null }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await sendMessage("c1", "How is the team?", [], "voice", "spoken");
    const body = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect(body.get("reply_style")).toBe("spoken");
    await sendMessage("c1", "Hello");
    const plain = (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as FormData;
    expect(plain.get("reply_style")).toBeNull();
  });
});
