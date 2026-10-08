import type { Employee } from "@/lib/employees";

export interface OrgNode {
  employee: Employee;
  reports: OrgNode[];
  /** Everyone below this person. */
  size: number;
}

export interface OrgTree {
  roots: OrgNode[];
  /** People whose supervisor isn't in the roster (should never happen). */
  unattached: Employee[];
}

/**
 * Builds the reporting tree from the flat roster. Directors are listed before
 * staff, then alphabetically; cycles (rejected by the backend anyway) are cut.
 */
export function buildOrgTree(
  employees: Employee[],
  directorIds: ReadonlySet<string> = new Set(),
  departmentOrder: ReadonlyMap<string, number> = new Map(),
): OrgTree {
  const byId = new Map(employees.map((e) => [e.id, e]));
  const children = new Map<string, Employee[]>();
  const roots: Employee[] = [];
  const unattached: Employee[] = [];
  for (const e of employees) {
    if (e.supervisor_id === null) roots.push(e);
    else if (!byId.has(e.supervisor_id)) unattached.push(e);
    else children.set(e.supervisor_id, [...(children.get(e.supervisor_id) ?? []), e]);
  }
  const rank = (e: Employee) => departmentOrder.get(e.department) ?? Number.MAX_SAFE_INTEGER;
  const order = (a: Employee, b: Employee) =>
    Number(directorIds.has(b.id)) - Number(directorIds.has(a.id)) ||
    rank(a) - rank(b) ||
    a.name.localeCompare(b.name);
  const visited = new Set<string>();
  const build = (e: Employee): OrgNode => {
    visited.add(e.id);
    const reports = (children.get(e.id) ?? []).filter((c) => !visited.has(c.id)).sort(order).map(build);
    return { employee: e, reports, size: reports.reduce((n, r) => n + 1 + r.size, 0) };
  };
  return { roots: roots.sort(order).map(build), unattached };
}
