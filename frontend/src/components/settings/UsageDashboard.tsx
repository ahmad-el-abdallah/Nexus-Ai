"use client";

import type { UsageSummary } from "@/lib/ai";
import { useEmployeeStore } from "@/world/state/employeeStore";

import { Badge, Section } from "./ui";

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl bg-white/[0.03] px-4 py-3 ring-1 ring-nx-line">
      <p className="text-[11px] tracking-wider text-nx-faint uppercase">{label}</p>
      <p className="mt-1 font-mono text-xl text-nx-text">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-nx-faint">{sub}</p>}
    </div>
  );
}

function Bars({ title, rows }: { title: string; rows: UsageSummary["by_model"] }) {
  const max = Math.max(1, ...rows.map((r) => r.requests));
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-nx-muted">{title}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-nx-faint">No requests yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.slice(0, 8).map((r) => (
            <li key={r.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 text-xs">
              <span className="truncate font-mono text-nx-text" title={r.name}>
                {r.name}
              </span>
              <span className="text-nx-faint">
                {r.requests} req{r.errors ? ` · ${r.errors} failed` : ""}
              </span>
              <span className="col-span-2 h-1.5 rounded-full bg-white/5">
                <span className="block h-full rounded-full bg-nx-cyan/70" style={{ width: `${(r.requests / max) * 100}%` }} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const fmt = (n: number) => n.toLocaleString();

/** Live usage from the gateway's records (no prompt or reply text is stored). */
export function UsageDashboard({ usage }: { usage: UsageSummary }) {
  const employees = useEmployeeStore((s) => s.employees);
  const name = (id: string | null) => (id ? (employees.find((e) => e.id === id)?.name ?? "—") : "—");
  const used = usage.budget.limit ? Math.min(1, usage.budget.used_24h / usage.budget.limit) : 1;
  return (
    <Section id="usage-title" title="Usage — last 24 hours" aside="Refreshes every 10 s · prompts and replies are never stored">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="usage-tiles">
        <Tile label="Requests sent" value={fmt(usage.requests)} sub={`${usage.ok} ok · ${usage.errors} failed`} />
        <Tile label="Blocked locally" value={fmt(usage.rejected)} sub="budget, pause or config" />
        <Tile label="Retries" value={fmt(usage.retries)} sub="rate limits & server errors" />
        <Tile label="Tokens in / out" value={`${fmt(usage.tokens.prompt)} / ${fmt(usage.tokens.completion)}`} sub={`${fmt(usage.tokens.reasoning)} reasoning`} />
        <Tile label="Median latency" value={usage.latency_ms.p50 === null ? "—" : `${(usage.latency_ms.p50 / 1000).toFixed(1)} s`} sub={usage.latency_ms.max === null ? "no data" : `max ${(usage.latency_ms.max / 1000).toFixed(1)} s`} />
        <Tile label="Budget left today" value={fmt(usage.budget.remaining)} sub={`of ${fmt(usage.budget.limit)} requests`} />
      </div>
      <div className="mt-3 h-1.5 rounded-full bg-white/5" aria-label={`Daily budget ${Math.round(used * 100)}% used`} role="img">
        <div className={`h-full rounded-full ${used > 0.9 ? "bg-nx-error" : used > 0.7 ? "bg-nx-warn" : "bg-nx-ok"}`} style={{ width: `${used * 100}%` }} />
      </div>
      <div className="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Bars title="By model" rows={usage.by_model} />
        <Bars title="By department" rows={usage.by_department} />
        <div>
          <p className="mb-2 text-xs font-medium text-nx-muted">Failures by kind</p>
          {usage.by_error.length === 0 ? (
            <p className="text-xs text-nx-faint">No failures.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {usage.by_error.map((e) => (
                <li key={e.kind}>
                  <Badge tone="error">
                    {e.kind.replace(/_/g, " ")} · {e.count}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-xs" data-testid="usage-recent">
          <thead className="text-[10px] tracking-wider text-nx-faint uppercase">
            <tr>
              <th className="py-2 font-medium">When</th>
              <th className="py-2 font-medium">Model</th>
              <th className="py-2 font-medium">Employee</th>
              <th className="py-2 font-medium">Purpose</th>
              <th className="py-2 font-medium">Result</th>
              <th className="py-2 text-right font-medium">Tokens in/out</th>
              <th className="py-2 text-right font-medium">Latency</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-nx-line">
            {usage.recent.map((r) => (
              <tr key={r.id}>
                <td className="py-2 text-nx-faint">{r.at ? new Date(r.at + (r.at.endsWith("Z") || r.at.includes("+") ? "" : "Z")).toLocaleTimeString() : "—"}</td>
                <td className="max-w-56 truncate py-2 font-mono text-nx-text" title={r.model ?? ""}>
                  {r.model ?? "—"}
                </td>
                <td className="py-2 text-nx-muted">{name(r.employee_id)}</td>
                <td className="py-2 text-nx-muted">{r.purpose.replace(/_/g, " ")}</td>
                <td className="py-2">
                  {r.status === "ok" ? (
                    <Badge tone="ok">ok{r.retries ? ` · ${r.retries} retr.` : ""}</Badge>
                  ) : r.status === "rejected" ? (
                    <Badge tone="neutral">blocked · {r.error_kind}</Badge>
                  ) : (
                    <Badge tone="error">{(r.error_kind ?? "error").replace(/_/g, " ")}</Badge>
                  )}
                </td>
                <td className="py-2 text-right font-mono text-nx-muted">{r.prompt_tokens ?? "—"} / {r.completion_tokens ?? "—"}</td>
                <td className="py-2 text-right font-mono text-nx-muted">{r.latency_ms === null ? "—" : `${(r.latency_ms / 1000).toFixed(1)} s`}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {usage.recent.length === 0 && <p className="py-4 text-center text-sm text-nx-muted">No AI requests in this window.</p>}
      </div>
    </Section>
  );
}
