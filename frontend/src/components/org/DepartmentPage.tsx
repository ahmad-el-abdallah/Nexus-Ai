"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";

import { TaskBoard } from "@/components/chat/TaskBoard";
import { EmployeeEditor } from "@/components/hq/EmployeeEditor";
import { Initials, StatusBadge } from "@/components/hq/people";
import type { Department } from "@/lib/departments";
import type { Employee } from "@/lib/employees";
import { chatHref } from "@/lib/routing";
import { ROOMS, WORKSTATIONS } from "@/world/layout/building";
import { ROOM_BY_ID } from "@/world/layout/queries";
import { useDepartmentStore } from "@/world/state/departmentStore";
import { useEmployeeStore } from "@/world/state/employeeStore";

import { ModelPicker } from "@/components/settings/ModelPicker";
import { useAIStore } from "@/world/state/aiStore";

import { AppShell, LoadState } from "./AppShell";

function deskName(deskId: string | null): string {
  if (!deskId) return "Remote";
  const ws = WORKSTATIONS.find((w) => w.id === deskId);
  return ws ? `${ROOM_BY_ID.get(ws.room)?.name ?? ws.room} · desk ${deskId.split("-").pop()}` : deskId;
}

const card = "glass-solid p-5";
const h2 = "text-sm font-semibold text-nx-text";

export function DepartmentPage({ departmentKey }: { departmentKey: string }) {
  const department = useDepartmentStore((s) => s.departments.find((d) => d.key === departmentKey));
  const load = useDepartmentStore((s) => s.load);
  const error = useDepartmentStore((s) => s.error);
  const employees = useEmployeeStore((s) => s.employees);
  const [editing, setEditing] = useState<Employee | "new" | null>(null);

  if (!department) {
    return (
      <AppShell title="Department">
        {load === "ready" ? <p className="text-sm text-nx-muted">No department called “{departmentKey}”.</p> : <LoadState load={load} error={error} />}
        <Link href="/departments" className="text-sm text-nx-indigo hover:text-nx-cyan">
          ← All departments
        </Link>
      </AppShell>
    );
  }

  const team = employees.filter((e) => e.department === department.key).sort((a, b) => Number(b.id === department.director_id) - Number(a.id === department.director_id) || a.name.localeCompare(b.name));
  const nameOf = (id: string | null) => employees.find((e) => e.id === id)?.name ?? "—";
  const room = department.room_id ? ROOM_BY_ID.get(department.room_id) : undefined;

  return (
    <AppShell
      title={department.name}
      subtitle={department.description}
      actions={
        <div className="flex flex-wrap gap-2">
          <Link href={chatHref({ kind: "department", department: department.key })} className="rounded-xl px-4 py-2 text-sm text-nx-text ring-1 ring-nx-violet/60 hover:bg-nx-violet/20">
            Message {department.name}
          </Link>
          {room && (
            <Link href={`/?room=${room.id}`} className="rounded-xl px-4 py-2 text-sm text-nx-text ring-1 ring-nx-line-strong hover:bg-white/5">
              View office in 3D
            </Link>
          )}
          <button type="button" onClick={() => setEditing("new")} className="rounded-xl bg-nx-violet/30 px-4 py-2 text-sm font-semibold text-white ring-1 ring-nx-violet/60 hover:bg-nx-violet/40">
            Hire into {department.name}
          </button>
        </div>
      }
    >
      <div className="h-1 w-full rounded-full" style={{ background: `linear-gradient(90deg, ${department.color}, transparent)` }} />

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-nx-line md:grid-cols-4">
        {[
          ["Director", department.director_id ? nameOf(department.director_id) : "Not appointed"],
          ["Team", `${team.length} AI employee${team.length === 1 ? "" : "s"}`],
          ["Office", room ? room.name : "No office yet (remote)"],
          ["Limits", `${department.max_concurrent_tasks} concurrent · ${department.daily_request_budget} requests/day`],
        ].map(([k, v]) => (
          <div key={k} className="bg-nx-bg/85 px-4 py-3">
            <dt className="text-[11px] tracking-wider text-nx-faint uppercase">{k}</dt>
            <dd className="mt-1 text-sm text-nx-text">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <section className={`${card} xl:col-span-2`} aria-labelledby="team-title">
          <h2 id="team-title" className={h2}>
            Team
          </h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm" data-testid="team-table">
              <thead className="text-[11px] tracking-wider text-nx-faint uppercase">
                <tr>
                  <th className="py-2 font-medium">Employee</th>
                  <th className="py-2 font-medium">Seniority</th>
                  <th className="py-2 font-medium">Desk</th>
                  <th className="py-2 font-medium">Reports to</th>
                  <th className="py-2 font-medium">Status</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-nx-line">
                {team.map((e) => (
                  <tr key={e.id}>
                    <td className="py-2.5">
                      <span className="flex items-center gap-3">
                        <Initials employee={e} size="size-8" />
                        <span>
                          <span className="block text-nx-text">
                            <Link href={`/employees/${e.id}`} className="hover:text-nx-cyan">
                              {e.name}
                            </Link>
                            {e.id === department.director_id && (
                              <span className="ml-2 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase" style={{ background: `${department.color}22`, color: department.color }}>
                                Director
                              </span>
                            )}
                          </span>
                          <span className="block text-xs text-nx-faint">{e.role}</span>
                        </span>
                      </span>
                    </td>
                    <td className="text-xs text-nx-muted capitalize">{e.seniority}</td>
                    <td className="text-xs text-nx-muted">{deskName(e.desk_id)}</td>
                    <td className="text-xs text-nx-muted">{e.supervisor_id ? nameOf(e.supervisor_id) : "— (top)"}</td>
                    <td>
                      <StatusBadge employee={e} />
                    </td>
                    <td className="text-right">
                      <button type="button" onClick={() => setEditing(e)} className="rounded-lg px-2.5 py-1 text-xs text-nx-muted ring-1 ring-nx-line-strong hover:text-nx-text" aria-label={`Edit ${e.name}`}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {team.length === 0 && <p className="py-4 text-sm text-nx-muted">No one works here yet.</p>}
          </div>
        </section>

        <section className={card} aria-labelledby="roles-title">
          <h2 id="roles-title" className={h2}>
            Roles
          </h2>
          <ul className="mt-3 space-y-1.5 text-sm">
            {department.roles.map((role, i) => {
              const filled = team.filter((e) => e.role === role).length;
              return (
                <li key={role} className="flex items-center justify-between gap-3">
                  <span className="text-nx-text">
                    {role}
                    {i === 0 && <span className="ml-1.5 text-[10px] text-nx-faint uppercase">director role</span>}
                  </span>
                  <span className={`text-xs ${filled ? "text-nx-ok" : "text-nx-faint"}`}>{filled ? `${filled} filled` : "open"}</span>
                </li>
              );
            })}
          </ul>
          <h2 className={`${h2} mt-6`}>Responsibilities</h2>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-nx-muted">
            {department.responsibilities.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>
      </div>

      <section className={card} aria-labelledby="tasks-title">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="tasks-title" className={h2}>
            Task board
          </h2>
          <p className="text-xs text-nx-faint">Live tasks from workflows, plus tasks you recorded from chat.</p>
        </div>
        <TaskBoard department={department.key} />
      </section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <DepartmentConfig department={department} team={team} />
        <section className={card} aria-labelledby="later-title">
          <h2 id="later-title" className={h2}>
            Arriving in later stages
          </h2>
          <ul className="mt-3 space-y-2 text-sm text-nx-muted">
            <li>Performance dashboard — Stage 10 (no data yet)</li>
            <li>Department knowledge base — Stage 13</li>
          </ul>
        </section>
      </div>

      {editing && (
        <EmployeeEditor employee={editing === "new" ? undefined : editing} department={department.key} onClose={() => setEditing(null)} />
      )}
    </AppShell>
  );
}

const input = "mt-1 h-10 w-full rounded-lg bg-nx-bg/80 px-3 text-sm text-nx-text ring-1 ring-nx-line-strong focus:ring-nx-violet/60 focus:outline-none";
const labelCls = "block text-xs font-medium text-nx-muted";
const OFFICE_ROOMS = ROOMS.filter((r) => r.kind !== "amenity");

function DepartmentConfig({ department, team }: { department: Department; team: Employee[] }) {
  const configure = useDepartmentStore((s) => s.configure);
  const refreshEmployees = useEmployeeStore((s) => s.refresh);
  const [form, setForm] = useState(() => ({
    name: department.name,
    description: department.description,
    color: department.color,
    room_id: department.room_id ?? "",
    director_id: department.director_id ?? "",
    model_id: department.model_id ?? null,
    max_concurrent_tasks: department.max_concurrent_tasks,
    daily_request_budget: department.daily_request_budget,
  }));
  const [state, setState] = useState<{ saving: boolean; message: string | null; error: string | null }>({ saving: false, message: null, error: null });

  async function save(e: FormEvent) {
    e.preventDefault();
    setState({ saving: true, message: null, error: null });
    try {
      await configure(department.key, {
        ...form,
        room_id: form.room_id || null,
        director_id: form.director_id || null,
      });
      void refreshEmployees(); // reporting lines may have changed with a new director
      void useAIStore.getState().refresh();
      setState({ saving: false, message: "Saved.", error: null });
    } catch (err) {
      setState({ saving: false, message: null, error: (err as Error).message });
    }
  }

  return (
    <form className={`${card} xl:col-span-2`} onSubmit={save} aria-labelledby="config-title" data-testid="department-config">
      <h2 id="config-title" className={h2}>
        Configuration
      </h2>
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className={labelCls}>
          Name
          <input required minLength={2} maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} />
        </label>
        <label className={labelCls}>
          Colour
          <span className="mt-1 flex gap-2">
            <input type="color" aria-label="Colour picker" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} className="h-10 w-12 rounded-lg bg-transparent" />
            <input value={form.color} pattern="^#[0-9a-fA-F]{6}$" onChange={(e) => setForm({ ...form, color: e.target.value })} className={`${input} mt-0 font-mono`} aria-label="Colour hex" />
          </span>
        </label>
        <label className={`${labelCls} md:col-span-2`}>
          Mission
          <textarea rows={3} maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={`${input} h-auto py-2`} />
        </label>
        <label className={labelCls}>
          Director
          <select value={form.director_id} onChange={(e) => setForm({ ...form, director_id: e.target.value })} className={input}>
            <option value="">{department.key === "executive" ? "— (required)" : "No director"}</option>
            {team.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} — {m.role}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          Office
          <select value={form.room_id} onChange={(e) => setForm({ ...form, room_id: e.target.value })} className={input}>
            <option value="">No office (remote)</option>
            {OFFICE_ROOMS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className={`${labelCls} md:col-span-2`}>
          AI model for this department
          <ModelPicker label="AI model for this department" value={form.model_id} onChange={(v) => setForm({ ...form, model_id: v })} inheritLabel="Company default" className={input} />
        </label>
        <label className={labelCls}>
          Max concurrent tasks
          <input type="number" min={1} max={20} value={form.max_concurrent_tasks} onChange={(e) => setForm({ ...form, max_concurrent_tasks: Number(e.target.value) })} className={input} />
        </label>
        <label className={labelCls}>
          Daily AI request budget
          <input type="number" min={0} max={100000} value={form.daily_request_budget} onChange={(e) => setForm({ ...form, daily_request_budget: Number(e.target.value) })} className={input} />
        </label>
      </div>
      <p className="mt-3 text-xs text-nx-faint">The request budget and concurrency limit apply to every AI call made for this department&apos;s employees.</p>
      <div className="mt-4 flex items-center gap-3">
        <button type="submit" disabled={state.saving} className="rounded-lg bg-nx-violet/30 px-4 py-2 text-sm font-semibold text-white ring-1 ring-nx-violet/60 hover:bg-nx-violet/40 disabled:opacity-50">
          {state.saving ? "Saving…" : "Save configuration"}
        </button>
        {state.message && <span role="status" className="text-sm text-nx-ok">{state.message}</span>}
        {state.error && <span role="alert" className="text-sm text-nx-error">{state.error}</span>}
      </div>
    </form>
  );
}
