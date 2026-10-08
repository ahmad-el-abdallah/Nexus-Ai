"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { EmployeeEditor } from "@/components/hq/EmployeeEditor";
import { Initials } from "@/components/hq/people";
import { ROOM_BY_ID } from "@/world/layout/queries";
import { useDepartmentStore } from "@/world/state/departmentStore";
import { useEmployeeStore } from "@/world/state/employeeStore";

import { AppShell, LoadState } from "./AppShell";

/** All 20 departments at a glance. */
export function DepartmentDirectory() {
  const departments = useDepartmentStore((s) => s.departments);
  const load = useDepartmentStore((s) => s.load);
  const error = useDepartmentStore((s) => s.error);
  const employees = useEmployeeStore((s) => s.employees);
  const [query, setQuery] = useState("");
  const [hiring, setHiring] = useState(false);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? departments.filter((d) => [d.name, d.description, ...d.roles].some((f) => f.toLowerCase().includes(q)))
      : departments;
  }, [departments, query]);
  const onSite = employees.filter((e) => e.desk_id).length;

  return (
    <AppShell
      title="Departments"
      subtitle={
        <>
          {departments.length} departments · {employees.length} AI employees ({onSite} on site, {employees.length - onSite} remote).
          Departments without an office work remotely until the building expands.
        </>
      }
      actions={
        <div className="flex gap-2">
          <input
            type="search"
            aria-label="Filter departments"
            placeholder="Filter by name or role…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-10 w-56 rounded-xl bg-nx-bg/70 px-4 text-sm text-nx-text ring-1 ring-nx-line-strong placeholder:text-nx-faint focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setHiring(true)}
            disabled={departments.length === 0}
            className="rounded-xl bg-nx-violet/30 px-4 text-sm font-semibold text-white ring-1 ring-nx-violet/60 hover:bg-nx-violet/40 disabled:opacity-40"
          >
            Hire employee
          </button>
        </div>
      }
    >
      <LoadState load={load} error={error} empty={departments.length === 0 && load !== "error"} />
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Departments">
        {shown.map((d) => {
          const director = employees.find((e) => e.id === d.director_id);
          return (
            <li key={d.key}>
              <Link
                href={`/departments/${d.key}`}
                data-department={d.key}
                className="glass-solid flex h-full flex-col gap-3 p-5 transition hover:ring-1 hover:ring-white/20"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-nx-faint">{String(d.position).padStart(2, "0")}</span>
                  <span className="size-2.5 rounded-full" style={{ background: d.color, boxShadow: `0 0 10px ${d.color}` }} />
                </div>
                <h2 className="text-base font-semibold text-nx-text">{d.name}</h2>
                <p className="line-clamp-2 text-xs leading-5 text-nx-muted">{d.description}</p>
                <div className="mt-auto flex items-center gap-2 border-t border-nx-line pt-3">
                  {director ? <Initials employee={director} size="size-7" /> : <span className="size-7 rounded-full ring-1 ring-dashed ring-nx-line-strong" />}
                  <span className="min-w-0 flex-1 truncate text-xs text-nx-text">{director ? director.name : "No director"}</span>
                  <span className="text-xs text-nx-faint">{d.headcount} staff</span>
                </div>
                <p className="text-[11px] text-nx-faint">{d.room_id ? `Office: ${ROOM_BY_ID.get(d.room_id)?.name ?? d.room_id}` : "No office yet · remote"}</p>
              </Link>
            </li>
          );
        })}
      </ul>
      {hiring && <EmployeeEditor onClose={() => setHiring(false)} />}
    </AppShell>
  );
}
