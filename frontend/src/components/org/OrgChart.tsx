"use client";

import { useMemo, useState } from "react";

import { EmployeeEditor } from "@/components/hq/EmployeeEditor";
import { Initials, StatusBadge, useDepartmentMeta } from "@/components/hq/people";
import type { Employee } from "@/lib/employees";
import { useDepartmentStore } from "@/world/state/departmentStore";
import { useEmployeeStore } from "@/world/state/employeeStore";

import { AppShell, LoadState } from "./AppShell";
import { buildOrgTree, type OrgNode } from "./orgTree";

function DeptChip({ departmentKey }: { departmentKey: string }) {
  const meta = useDepartmentMeta(departmentKey);
  return (
    <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: `${meta.color}22`, color: meta.color }}>
      {meta.name}
    </span>
  );
}

function Node({
  node,
  depth,
  open,
  toggle,
  onEdit,
  directors,
}: {
  node: OrgNode;
  depth: number;
  open: ReadonlySet<string>;
  toggle: (id: string) => void;
  onEdit: (e: Employee) => void;
  directors: ReadonlySet<string>;
}) {
  const e = node.employee;
  const expanded = open.has(e.id);
  return (
    <li role="treeitem" aria-expanded={node.reports.length ? expanded : undefined} aria-level={depth + 1} aria-selected={false} data-employee={e.name}>
      <div className="group flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-white/[0.04]">
        <button
          type="button"
          onClick={() => toggle(e.id)}
          disabled={!node.reports.length}
          aria-label={node.reports.length ? `${expanded ? "Collapse" : "Expand"} ${e.name}'s team` : undefined}
          className="grid size-6 place-items-center rounded-md text-xs text-nx-muted ring-1 ring-transparent hover:ring-nx-line-strong disabled:opacity-0"
        >
          {expanded ? "−" : "+"}
        </button>
        <Initials employee={e} size="size-8" />
        <button type="button" onClick={() => onEdit(e)} className="min-w-0 flex-1 text-left" aria-label={`Edit ${e.name}`}>
          <span className="block truncate text-sm text-nx-text">
            {e.name}
            {directors.has(e.id) && <span className="ml-2 text-[10px] font-semibold tracking-wider text-nx-faint uppercase">director</span>}
          </span>
          <span className="block truncate text-xs text-nx-faint">{e.role}</span>
        </button>
        <span className="hidden sm:inline">
          <DeptChip departmentKey={e.department} />
        </span>
        <span className="hidden w-20 text-right text-xs text-nx-faint md:inline">{e.desk_id ? "on site" : "remote"}</span>
        <span className="hidden w-24 md:inline">
          <StatusBadge employee={e} />
        </span>
        <span className="w-16 text-right font-mono text-[11px] text-nx-faint">{node.size ? `${node.size} below` : ""}</span>
      </div>
      {expanded && node.reports.length > 0 && (
        <ul role="group" className="ml-5 border-l border-nx-line pl-3">
          {node.reports.map((r) => (
            <Node key={r.employee.id} node={r} depth={depth + 1} open={open} toggle={toggle} onEdit={onEdit} directors={directors} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The company's reporting hierarchy, from the CEO down. */
export function OrgChart() {
  const employees = useEmployeeStore((s) => s.employees);
  const load = useEmployeeStore((s) => s.load);
  const error = useEmployeeStore((s) => s.error);
  const departments = useDepartmentStore((s) => s.departments);
  const directors = useMemo(() => new Set(departments.map((d) => d.director_id).filter((x): x is string => !!x)), [departments]);
  const tree = useMemo(
    () => buildOrgTree(employees, directors, new Map(departments.map((d) => [d.key, d.position]))),
    [employees, directors, departments],
  );
  // null until the owner expands or collapses anything: the top level starts open.
  const [open, setOpen] = useState<Set<string> | null>(null);
  const [editing, setEditing] = useState<Employee | null>(null);
  const effectiveOpen = useMemo(() => open ?? new Set(tree.roots.map((r) => r.employee.id)), [open, tree.roots]);

  const toggle = (id: string) =>
    setOpen(() => {
      const next = new Set(effectiveOpen);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const expandAll = () => setOpen(new Set(employees.map((e) => e.id)));
  const collapseAll = () => setOpen(new Set());

  return (
    <AppShell
      title="Org chart"
      subtitle="Reporting lines across all departments. Directors report to the CEO; everyone else to their director unless you change it. Click a person to edit."
      actions={
        <div className="flex gap-2">
          <button type="button" onClick={expandAll} className="rounded-xl px-4 py-2 text-sm text-nx-text ring-1 ring-nx-line-strong hover:bg-white/5">
            Expand all
          </button>
          <button type="button" onClick={collapseAll} className="rounded-xl px-4 py-2 text-sm text-nx-text ring-1 ring-nx-line-strong hover:bg-white/5">
            Collapse
          </button>
        </div>
      }
    >
      <LoadState load={load} error={error} empty={employees.length === 0 && load !== "error"} />
      {tree.roots.length > 0 && (
        <section className="glass-solid p-4">
          <ul role="tree" aria-label="Reporting hierarchy" data-testid="org-tree">
            {tree.roots.map((root) => (
              <Node key={root.employee.id} node={root} depth={0} open={effectiveOpen} toggle={toggle} onEdit={setEditing} directors={directors} />
            ))}
          </ul>
          {tree.unattached.length > 0 && (
            <p role="alert" className="mt-4 text-sm text-nx-warn">
              {tree.unattached.length} employee(s) report to someone who no longer exists.
            </p>
          )}
        </section>
      )}
      {editing && <EmployeeEditor employee={editing} onClose={() => setEditing(null)} />}
    </AppShell>
  );
}
