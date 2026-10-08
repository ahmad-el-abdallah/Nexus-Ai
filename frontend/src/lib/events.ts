/**
 * One live connection per tab to `/api/events` (Server-Sent Events through the
 * same-origin proxy). Events are notifications about changes the backend has
 * already saved; after a reconnect, listeners reload their state.
 */

export type LiveStatus = "connecting" | "open" | "closed";

const RETRY_MS = 3_000;

type Handler = (data: unknown) => void;
type StatusHandler = (status: LiveStatus, reconnected: boolean) => void;

export const LIVE_EVENTS = [
  "ready",
  "resync",
  "employee.updated",
  "roster.changed",
  "conversation.updated",
  "conversation.deleted",
  "message.created",
  "message.updated",
  "message.token",
  "reply.state",
  "task.updated",
  "voice.updated",
  "voice.settings",
  "workflow.updated",
  "workflow.event",
  "employee.screen",
  "email.account",
  "email.message",
  "email.log",
  "email.inbox",
  "email.deleted",
  "email.removed",
  "run.updated",
] as const;
export type LiveEventType = (typeof LIVE_EVENTS)[number];

class LiveEvents {
  private source: EventSource | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private statusHandlers = new Set<StatusHandler>();
  private users = 0;
  private everOpen = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  status: LiveStatus = "closed";

  /** Keeps the connection open while at least one caller holds it. */
  retain(): () => void {
    this.users += 1;
    if (this.users === 1) this.connect();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.users -= 1;
      if (this.users === 0) this.disconnect();
    };
  }

  on(type: LiveEventType, handler: Handler): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler);
    this.handlers.set(type, set);
    return () => set.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private setStatus(status: LiveStatus) {
    const reconnected = status === "open" && this.everOpen;
    if (status === "open") this.everOpen = true;
    if (status === this.status && !reconnected) return;
    this.status = status;
    for (const h of this.statusHandlers) h(status, reconnected);
  }

  private connect() {
    if (typeof EventSource === "undefined" || this.source) return;
    this.setStatus("connecting");
    const source = new EventSource("/api/events");
    this.source = source;
    source.onopen = () => this.setStatus("open");
    source.onerror = () => {
      // EventSource retries by itself while CONNECTING; a failed response (e.g. the
      // backend is down behind the proxy) closes it for good, so retry here.
      if (source.readyState !== EventSource.CLOSED) return this.setStatus("connecting");
      this.disconnect();
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.users > 0) this.connect();
      }, RETRY_MS);
    };
    for (const type of LIVE_EVENTS) {
      source.addEventListener(type, (event) => {
        let data: unknown = {};
        try {
          data = JSON.parse((event as MessageEvent<string>).data);
        } catch {
          return;
        }
        if (type === "resync") {
          // The server dropped us for falling behind: reconnect and reload.
          this.disconnect();
          this.connect();
          return;
        }
        for (const h of this.handlers.get(type) ?? []) h(data);
      });
    }
  }

  private disconnect() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.source?.close();
    this.source = null;
    this.setStatus("closed");
  }
}

export const liveEvents = new LiveEvents();
