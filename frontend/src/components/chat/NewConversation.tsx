"use client";

import { useState } from "react";

import { Initials, StatusBadge } from "@/components/hq/people";
import type { Addressee } from "@/lib/routing";
import { responderFor } from "@/lib/routing";
import { useDepartmentStore } from "@/world/state/departmentStore";
import { useEmployeeStore } from "@/world/state/employeeStore";

/** Pick who to talk to: the CEO, a department, or any employee. */
export function NewConversation({ onPick }: { onPick: (to: Addressee) => void }) {
  const employees = useEmployeeStore((s) => s.employees);
  const departments = useDepartmentStore((s) => s.departments);
  const [filter, setFilter] = useState("");
  const executive = departments.find((d) => d.key === "executive");
  const ceo = employees.find((e) => e.id === executive?.director_id);
  const needle = filter.trim().toLowerCase();
  const people = employees
    .filter((e) => !needle || `${e.name} ${e.role} ${e.department}`.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name));
  const teams = departments.filter((d) => !needle || d.name.toLowerCase().includes(needle));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5" data-testid="new-conversation">
      <h2 className="text-base font-semibold text-nx-text">Start a conversation</h2>
      <p className="mt-1 text-sm text-nx-muted">Replies come from the employee&apos;s routed NVIDIA model and use the daily request budget.</p>

      {ceo && (
        <button
          type="button"
          onClick={() => onPick({ kind: "employee", employee_id: ceo.id })}
          className="mt-4 flex w-full items-center gap-3 rounded-xl bg-gradient-to-r from-nx-violet/20 to-nx-cyan/10 p-4 text-left ring-1 ring-nx-violet/40 hover:from-nx-violet/30"
        >
          <Initials employee={ceo} size="size-11" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-nx-text">Message the CEO</span>
            <span className="block truncate text-xs text-nx-muted">
              {ceo.name} · {ceo.role}
            </span>
          </span>
          <StatusBadge employee={ceo} />
        </button>
      )}

      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter departments and people"
        aria-label="Filter departments and people"
        className="mt-5 h-9 w-full rounded-lg bg-nx-bg/80 px-3 text-sm text-nx-text ring-1 ring-nx-line-strong placeholder:text-nx-faint focus:ring-nx-violet/60 focus:outline-none"
      />

      <h3 className="mt-5 text-[11px] font-medium tracking-wider text-nx-faint uppercase">Departments</h3>
      <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label="Departments">
        {teams.map((d) => {
          const r = responderFor({ kind: "department", department: d.key }, employees, departments);
          return (
            <li key={d.key}>
              <button
                type="button"
                onClick={() => onPick({ kind: "department", department: d.key })}
                aria-label={`Message ${d.name}`}
                className="flex w-full items-center gap-3 rounded-xl bg-white/[0.02] p-3 text-left ring-1 ring-nx-line hover:bg-white/[0.05]"
              >
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: d.color, boxShadow: `0 0 8px ${d.color}` }} />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-nx-text">{d.name}</span>
                  <span className="block truncate text-xs text-nx-faint">{r.employee ? `Answered by ${r.employee.name}` : "Nobody available"}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <h3 className="mt-6 text-[11px] font-medium tracking-wider text-nx-faint uppercase">People</h3>
      <ul className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2" aria-label="People">
        {people.map((e) => (
          <li key={e.id}>
            <button type="button" onClick={() => onPick({ kind: "employee", employee_id: e.id })} aria-label={`Message ${e.name}`} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-white/[0.04]">
              <Initials employee={e} size="size-8" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-nx-text">{e.name}</span>
                <span className="block truncate text-xs text-nx-faint">{e.role}</span>
              </span>
              <StatusBadge employee={e} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
