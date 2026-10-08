import { afterEach, describe, expect, it, vi } from "vitest";

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (e: { data: string }) => void>();
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, fn);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
}

async function freshModule() {
  vi.resetModules();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  return (await import("./events")).liveEvents;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("liveEvents", () => {
  it("shares one connection and delivers events to subscribers", async () => {
    const live = await freshModule();
    const got: unknown[] = [];
    const off = live.on("employee.updated", (d) => got.push(d));
    const a = live.retain();
    const b = live.retain();
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe("/api/events");
    source.open();
    expect(live.status).toBe("open");
    source.emit("employee.updated", { id: "e1" });
    expect(got).toEqual([{ id: "e1" }]);
    a();
    expect(source.closed).toBe(false);
    b();
    expect(source.closed).toBe(true);
    off();
  });

  it("reports reconnects so state can be reloaded", async () => {
    const live = await freshModule();
    const seen: [string, boolean][] = [];
    live.onStatus((s, reconnected) => seen.push([s, reconnected]));
    const release = live.retain();
    const source = FakeEventSource.instances[0];
    source.open();
    source.onerror?.(); // still CONNECTING → browser retries
    source.open();
    expect(seen).toEqual([
      ["connecting", false],
      ["open", false],
      ["connecting", false],
      ["open", true],
    ]);
    release();
  });

  it("retries by itself when the response failed for good", async () => {
    vi.useFakeTimers();
    const live = await freshModule();
    const release = live.retain();
    const first = FakeEventSource.instances[0];
    first.readyState = FakeEventSource.CLOSED;
    first.onerror?.();
    expect(live.status).toBe("closed");
    vi.advanceTimersByTime(3_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    release();
  });
});
