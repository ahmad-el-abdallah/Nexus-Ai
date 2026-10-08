"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { chatHref } from "@/lib/routing";
import { STATUS_META } from "@/world/characters/status";
import { officeWorld } from "@/world/characters/world";
import { WORKSTATIONS } from "@/world/layout/building";
import { ROOM_BY_ID } from "@/world/layout/queries";
import { useAIStore } from "@/world/state/aiStore";
import { useEmployeeStore } from "@/world/state/employeeStore";
import { useOfficeStore } from "@/world/state/officeStore";

import { EmployeeEditor } from "./EmployeeEditor";
import { Initials, relativeTime, useDepartmentMeta } from "./people";

function deskLabel(deskId: string | null): string {
  if (!deskId) return "No desk";
  const ws = WORKSTATIONS.find((w) => w.id === deskId);
  if (!ws) return "Desk not in this building";
  const room = ROOM_BY_ID.get(ws.room);
  const n = deskId.split("-").pop();
  return `${room?.name ?? ws.room} · desk ${n}`;
}

/** The selected AI employee. Shows recorded facts only; work data arrives with later stages. */
export function EmployeePanel() {
  const id = useOfficeStore((s) => s.selectedEmployeeId);
  const selectEmployee = useOfficeStore((s) => s.selectEmployee);
  const employee = useEmployeeStore((s) => s.employees.find((e) => e.id === id));
  const pending = useEmployeeStore((s) => (id ? !!s.pending[id] : false));
  const actionError = useEmployeeStore((s) => (id ? s.actionError[id] : ""));
  const setAvailability = useEmployeeStore((s) => s.setAvailability);
  // Read the clock only on the client, after mount (the page is prerendered).
  const [now, setNow] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const route = useAIStore((s) => s.routing.find((r) => r.employee_id === id));
  useEffect(() => {
    if (id) void useAIStore.getState().refresh();
  }, [id]);
  const dept = useDepartmentMeta(employee?.department ?? "");

  // "Doing" comes from the live 3D controller; refresh it twice a second.
  useEffect(() => {
    if (!id) return;
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const t = window.setInterval(tick, 500);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [id]);

  if (!id || !employee) return null;
  const meta = STATUS_META[employee.status];
  const doing = officeWorld.residents.get(employee.id)?.controller.doing ?? "—";
  const suspended = employee.status === "suspended";

  const facts: Array<[string, string]> = [
    ["Department", dept.name],
    ["Office", employee.desk_id ? "On site" : "Remote — no desk"],
    ["Seniority", employee.seniority[0].toUpperCase() + employee.seniority.slice(1)],
    ["Desk", deskLabel(employee.desk_id)],
    ["AI model", route?.model ? `${route.model.split("/").pop()} (${route.source})` : "None selected"],
  ];

  return (
    <aside
      aria-label={`${employee.name} details`}
      data-testid="employee-panel"
      className="glass-solid pointer-events-auto fixed inset-x-3 bottom-3 z-30 max-h-[44vh] overflow-y-auto p-5 md:inset-x-auto md:top-20 md:right-4 md:bottom-auto md:max-h-[calc(100vh-7rem)] md:w-[360px]"
    >
      <header className="flex items-start gap-3">
        <Initials employee={employee} size="size-12" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold tracking-wider uppercase" style={{ color: dept.color }}>
            AI employee · {dept.name}
          </p>
          <h2 className="mt-0.5 truncate text-xl font-semibold text-nx-text">{employee.name}</h2>
          <p className="truncate text-sm text-nx-muted">{employee.role}</p>
        </div>
        <button
          type="button"
          onClick={() => selectEmployee(null)}
          aria-label="Close employee details"
          className="grid size-8 shrink-0 place-items-center rounded-lg text-nx-muted ring-1 ring-nx-line-strong transition hover:bg-white/5 hover:text-nx-text"
        >
          ×
        </button>
      </header>

      <section className="mt-5 rounded-xl bg-white/[0.03] p-4 ring-1 ring-nx-line" aria-label="Status">
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-nx-text" data-testid="employee-status">
            <span className="size-2.5 rounded-full" style={{ background: meta.color, boxShadow: `0 0 10px ${meta.color}` }} />
            {meta.label}
          </span>
          {now !== null && <span className="text-xs text-nx-faint">since {relativeTime(employee.status_changed_at, now)}</span>}
        </div>
        <p className="mt-2 text-sm text-nx-muted">{employee.status_detail ?? meta.description}</p>
        <p className="mt-2 text-xs text-nx-faint" data-testid="employee-doing">
          In the office: {doing}
        </p>
      </section>

      <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-nx-line">
        {facts.map(([label, value]) => (
          <div key={label} className="bg-nx-bg/80 px-4 py-3">
            <dt className="text-[11px] tracking-wider text-nx-faint uppercase">{label}</dt>
            <dd className="mt-1 text-sm text-nx-text">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-white/[0.03] px-4 py-3 text-sm ring-1 ring-nx-line">
        <span className="shrink-0 text-nx-muted">Current task</span>
        <span className="text-right text-nx-text">None — task execution arrives in Stage 8</span>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Link
          href={chatHref({ kind: "employee", employee_id: employee.id })}
          className="rounded-lg bg-nx-violet/30 px-3 py-2 text-xs font-semibold text-white ring-1 ring-nx-violet/60 transition hover:bg-nx-violet/40"
        >
          Message
        </Link>
        <button
          type="button"
          onClick={() => useOfficeStore.getState().selectEmployee(employee.id)}
          disabled={suspended}
          className="rounded-lg px-3 py-2 text-xs font-medium text-nx-text ring-1 ring-nx-line-strong transition hover:bg-white/5 disabled:opacity-40"
        >
          Focus camera
        </button>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="rounded-lg px-3 py-2 text-xs font-medium text-nx-text ring-1 ring-nx-line-strong transition hover:bg-white/5"
        >
          Edit employee
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => void setAvailability(employee.id, suspended ? "activate" : "suspend")}
          className={`rounded-lg px-3 py-2 text-xs font-semibold ring-1 transition disabled:opacity-50 ${
            suspended
              ? "bg-nx-ok/15 text-nx-ok ring-nx-ok/40 hover:bg-nx-ok/25"
              : "bg-nx-warn/10 text-nx-warn ring-nx-warn/40 hover:bg-nx-warn/20"
          }`}
        >
          {pending ? "Saving…" : suspended ? "Activate employee" : "Suspend employee"}
        </button>
      </div>
      {actionError && (
        <p role="alert" className="mt-3 text-xs text-nx-error">
          {actionError}
        </p>
      )}
      <p className="mt-4 font-mono text-[11px] text-nx-faint">{employee.id}</p>
      {editing && <EmployeeEditor employee={employee} onClose={() => setEditing(false)} onDeleted={() => selectEmployee(null)} />}
    </aside>
  );
}
