"use client";

import type { HealthComponent, Readiness, SystemInfo } from "@/lib/api";
import { useSystemStatus, type SystemStatusState } from "@/hooks/useSystemStatus";

import { StatusDot, StatusPill, type Tone } from "./StatusPill";

interface Row {
  label: string;
  value: string;
  detail?: string;
  tone: Tone;
}

const DIALECTS: Record<string, string> = { sqlite: "SQLite", postgresql: "PostgreSQL" };

function componentTone(component: HealthComponent | undefined): Tone {
  switch (component?.status) {
    case "ok":
      return "ok";
    case "migrations_pending":
    case "paused":
      return "warn";
    case "configured":
    case "not_configured":
    case "error":
      return "error";
    case "planned":
      return "planned";
    default:
      return "neutral";
  }
}

function plannedValue(component: HealthComponent | undefined): string {
  const stage = component?.data.stage;
  return typeof stage === "number" ? `Planned · Stage ${stage}` : "Planned";
}

export function buildRows(state: SystemStatusState): Row[] {
  if (state.kind !== "online") {
    const unknown = state.kind === "loading" ? "Checking…" : "Unknown";
    return [
      {
        label: "API server",
        value: state.kind === "loading" ? "Checking…" : "Not reachable",
        tone: state.kind === "loading" ? "neutral" : "error",
      },
      { label: "Database", value: unknown, tone: "neutral" },
      { label: "Schema migrations", value: unknown, tone: "neutral" },
      { label: "AI provider · NVIDIA", value: unknown, tone: "neutral" },
      { label: "Company email", value: unknown, tone: "neutral" },
    ];
  }

  const { components } = state.readiness;
  const db = components.database;
  const migrations = components.migrations;
  const ai = components.ai_provider;
  const email = components.email;
  const dialect = DIALECTS[String(db?.data.dialect)] ?? String(db?.data.dialect ?? "");

  return [
    { label: "API server", value: "Responding", tone: "ok" },
    {
      label: "Database",
      value: db?.status === "ok" ? `Connected · ${dialect}` : "Unreachable",
      detail: db?.detail ?? undefined,
      tone: componentTone(db),
    },
    {
      label: "Schema migrations",
      value:
        migrations?.status === "ok"
          ? `Up to date · ${String(migrations.data.current)}`
          : migrations?.status === "migrations_pending"
            ? "Migrations pending"
            : "Not checked",
      detail: migrations?.detail ?? undefined,
      tone: componentTone(migrations),
    },
    {
      label: "AI provider · NVIDIA",
      value:
        ai?.status === "ok"
          ? `Connected · ${String(ai.data.default_model ?? "no default model")}`
          : ai?.status === "configured"
            ? "Key present · not tested"
            : ai?.status === "not_configured"
              ? "No API key"
              : ai?.status === "paused"
                ? "Paused (emergency stop)"
                : ai?.status === "error"
                  ? "Last connection test failed"
                  : plannedValue(ai),
      detail: ai?.detail ?? undefined,
      tone: ai?.status === "configured" || ai?.status === "not_configured" ? "neutral" : componentTone(ai),
    },
    {
      label: "Company email",
      value: plannedValue(email),
      detail: "No account connected",
      tone: componentTone(email),
    },
  ];
}

function overall(state: SystemStatusState): { tone: Tone; label: string } {
  if (state.kind === "loading") return { tone: "neutral", label: "Checking" };
  if (state.kind === "offline") return { tone: "error", label: "Backend offline" };
  return state.readiness.status === "ok"
    ? { tone: "ok", label: "Operational" }
    : { tone: "warn", label: "Degraded" };
}

function formatUptime(seconds: number): string {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function InstallationDetails({ info }: { info: SystemInfo | null }) {
  const items: Array<[string, string]> = info
    ? [
        ["Version", `v${info.version}`],
        ["Environment", info.environment],
        ["Uptime", formatUptime(info.uptime_seconds)],
        ["Installation", info.installation_id ? info.installation_id.slice(0, 8) : "Not initialised"],
      ]
    : [
        ["Version", "—"],
        ["Environment", "—"],
        ["Uptime", "—"],
        ["Installation", "—"],
      ];
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-nx-line sm:grid-cols-4">
      {items.map(([label, value]) => (
        <div key={label} className="bg-nx-bg/80 px-4 py-3">
          <dt className="text-[11px] tracking-wider text-nx-faint uppercase">{label}</dt>
          <dd className="mt-1 font-mono text-sm text-nx-text">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SystemStatus() {
  const { state, refreshing, refresh } = useSystemStatus();
  const rows = buildRows(state);
  const summary = overall(state);
  const readiness: Readiness | null = state.kind === "online" ? state.readiness : null;

  return (
    <section className="glass flex flex-col gap-5 p-6" aria-labelledby="system-status-title">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="system-status-title" className="text-base font-semibold text-nx-text">
            System status
          </h2>
          <p className="mt-0.5 text-xs text-nx-muted">
            Live readiness checks from the backend, refreshed every 10 seconds.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div aria-live="polite">
            <StatusPill tone={summary.tone}>{summary.label}</StatusPill>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-nx-muted ring-1 ring-nx-line-strong transition hover:bg-white/5 hover:text-nx-text disabled:opacity-50"
          >
            {refreshing ? "Checking…" : "Re-check"}
          </button>
        </div>
      </header>

      {state.kind === "offline" && (
        <div
          role="alert"
          className="rounded-xl bg-nx-error/10 px-4 py-3 text-sm text-nx-text ring-1 ring-nx-error/25"
        >
          <p className="font-medium text-nx-error">The backend is not reachable.</p>
          <p className="mt-1 text-nx-muted">
            Start it with <code className="font-mono text-nx-text">make dev</code> from the project
            root. This page reconnects automatically.
          </p>
        </div>
      )}

      <ul className="divide-y divide-nx-line overflow-hidden rounded-xl ring-1 ring-nx-line">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center gap-4 bg-white/[0.015] px-4 py-3">
            <StatusDot tone={row.tone} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-4">
              <span className="text-xs text-nx-muted sm:w-44 sm:shrink-0 sm:text-sm">{row.label}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-nx-text">{row.value}</span>
                {row.detail && (
                  <span className="block text-xs text-nx-faint sm:truncate">{row.detail}</span>
                )}
              </span>
            </div>
          </li>
        ))}
      </ul>

      <InstallationDetails info={state.kind === "online" ? state.info : null} />

      <footer className="flex flex-wrap items-center justify-between gap-2 text-xs text-nx-faint">
        <span>
          {state.kind === "loading"
            ? "Contacting backend…"
            : `Last checked ${state.checkedAt.toLocaleTimeString()}`}
          {readiness && readiness.status === "degraded" && " · see details above"}
        </span>
        <a href="/api/docs" target="_blank" rel="noreferrer" className="text-nx-indigo hover:text-nx-cyan">
          Backend API reference ↗
        </a>
      </footer>
    </section>
  );
}
