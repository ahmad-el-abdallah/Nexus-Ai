import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Readiness, SystemInfo } from "@/lib/api";

import { SystemStatus } from "./SystemStatus";

const INFO: SystemInfo = {
  name: "NEXUS AI",
  version: "0.1.0",
  environment: "development",
  installation_id: "0123456789abcdef0123456789abcdef",
  started_at: "2026-10-08T00:00:00Z",
  uptime_seconds: 125,
  database_dialect: "sqlite",
  nvidia_key_present: false,
};

function readiness(overrides: Partial<Readiness["components"]> = {}): Readiness {
  const components: Readiness["components"] = {
    database: { status: "ok", detail: null, critical: true, data: { dialect: "sqlite" } },
    migrations: {
      status: "ok",
      detail: null,
      critical: true,
      data: { current: "0001_initial", head: "0001_initial" },
    },
    ai_provider: {
      status: "not_configured",
      detail: "No NVIDIA API key configured",
      critical: false,
      data: { provider: "nvidia", key_present: false, default_model: null },
    },
    email: { status: "planned", detail: null, critical: false, data: { stage: 9 } },
    ...overrides,
  };
  const healthy = Object.values(components).every((c) => !c.critical || c.status === "ok");
  return { status: healthy ? "ok" : "degraded", checked_at: "2026-10-08T00:00:00Z", components };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockBackend(ready: Readiness, info: SystemInfo = INFO) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/health/ready")) return json(ready, ready.status === "ok" ? 200 : 503);
    if (url.endsWith("/api/system/info")) return json(info);
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function row(label: string) {
  return screen.getByText(label).closest("li") as HTMLElement;
}

describe("SystemStatus", () => {
  it("shows an operational system with real backend values", async () => {
    const fetchMock = mockBackend(readiness());
    render(<SystemStatus />);

    expect(await screen.findByText("Operational")).toBeInTheDocument();
    expect(within(row("Database")).getByText("Connected · SQLite")).toBeInTheDocument();
    expect(within(row("Schema migrations")).getByText("Up to date · 0001_initial")).toBeInTheDocument();
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
    expect(screen.getByText("2m 5s")).toBeInTheDocument();
    expect(screen.getByText("01234567")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/health/ready", expect.anything());
  });

  it("reports the AI provider's real state and unbuilt integrations as planned", async () => {
    mockBackend(readiness());
    render(<SystemStatus />);

    await screen.findByText("Operational");
    expect(within(row("AI provider · NVIDIA")).getByText("No API key")).toBeInTheDocument();
    expect(within(row("Company email")).getByText("Planned · Stage 9")).toBeInTheDocument();
  });

  it("reports whether local voice models are installed", async () => {
    mockBackend(
      readiness({
        voice: { status: "ok", detail: null, critical: false, data: { stt: ["whisper-base"], tts: ["piper-en", "piper-ar"], engine: "local" } },
      }),
    );
    render(<SystemStatus />);
    await screen.findByText("Operational");
    expect(within(row("Voice · local")).getByText("Ready · whisper-base + 2 voice(s)")).toBeInTheDocument();
  });

  it("shows a connected AI provider with its default model", async () => {
    mockBackend(
      readiness({
        ai_provider: { status: "ok", detail: "Last connection test passed", critical: false, data: { key_present: true, default_model: "acme/model" } },
      }),
    );
    render(<SystemStatus />);
    expect(await within(await screen.findByText("AI provider · NVIDIA").then((el) => el.closest("li") as HTMLElement)).findByText("Connected · acme/model")).toBeInTheDocument();
  });

  it("shows a degraded state when migrations are pending", async () => {
    mockBackend(
      readiness({
        migrations: {
          status: "migrations_pending",
          detail: "Run `make migrate` to apply pending migrations",
          critical: true,
          data: { current: null, head: "0001_initial" },
        },
      }),
    );
    render(<SystemStatus />);

    expect(await screen.findByText("Degraded")).toBeInTheDocument();
    expect(within(row("Schema migrations")).getByText("Migrations pending")).toBeInTheDocument();
    expect(screen.getByText("Run `make migrate` to apply pending migrations")).toBeInTheDocument();
  });

  it("shows an offline state with recovery instructions when the backend is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    render(<SystemStatus />);

    expect(await screen.findByText("Backend offline")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("make dev");
    expect(within(row("API server")).getByText("Not reachable")).toBeInTheDocument();
    expect(within(row("Database")).getByText("Unknown")).toBeInTheDocument();
  });

  it("treats a non-JSON proxy error page as offline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Internal Server Error", { status: 500 })),
    );
    render(<SystemStatus />);

    expect(await screen.findByText("Backend offline")).toBeInTheDocument();
  });
});
