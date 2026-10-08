/**
 * Who will answer a conversation — mirrors the backend rule in
 * app/services/chat.py (the backend decides; this only previews it):
 * an employee conversation is answered by that employee; a department
 * conversation by its director, else its most senior available member.
 */

import type { Department } from "./departments";
import type { Employee } from "./employees";
import { SENIORITY } from "./employees";

export interface Addressee {
  kind: "employee" | "department";
  employee_id?: string | null;
  department?: string | null;
}

export interface Responder {
  employee: Employee | null;
  /** Why nobody can answer (shown instead of the composer). */
  unavailable: string | null;
  /** How the responder was chosen, for department conversations. */
  via: "self" | "director" | "senior" | null;
}

export function responderFor(to: Addressee, employees: Employee[], departments: Department[]): Responder {
  if (to.kind === "employee") {
    const employee = employees.find((e) => e.id === to.employee_id) ?? null;
    if (!employee) return { employee: null, unavailable: "This employee no longer works at NEXUS AI.", via: null };
    if (employee.status === "suspended")
      return { employee, unavailable: `${employee.name} is suspended. Activate them to continue this conversation.`, via: "self" };
    return { employee, unavailable: null, via: "self" };
  }
  const department = departments.find((d) => d.key === to.department);
  const members = employees.filter((e) => e.department === to.department && e.status !== "suspended");
  if (!department) return { employee: null, unavailable: "This department no longer exists.", via: null };
  if (members.length === 0)
    return { employee: null, unavailable: `${department.name} has no available employee to reply (nobody hired, or everyone is suspended).`, via: null };
  const director = members.find((m) => m.id === department.director_id);
  if (director) return { employee: director, unavailable: null, via: "director" };
  const rank = (e: Employee) => {
    const i = SENIORITY.indexOf(e.seniority as (typeof SENIORITY)[number]);
    return i === -1 ? 99 : i;
  };
  const senior = [...members].sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
  return { employee: senior, unavailable: null, via: "senior" };
}

/** Parses `?to=employee:<id>` / `?to=department:<key>`. */
export function parseTarget(value: string | null): Addressee | null {
  if (!value) return null;
  const [kind, id] = value.split(":", 2);
  if (!id) return null;
  if (kind === "employee") return { kind, employee_id: id };
  if (kind === "department") return { kind, department: id };
  return null;
}

export const chatHref = (to: Addressee) =>
  `/chat?to=${to.kind}:${encodeURIComponent((to.kind === "employee" ? to.employee_id : to.department) ?? "")}`;
