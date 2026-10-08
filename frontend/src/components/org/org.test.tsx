import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import officeFile from "../../../../shared/office-desks.json";
import type { Department } from "@/lib/departments";
import type { Employee } from "@/lib/employees";
import { ROOMS, WORKSTATIONS } from "@/world/layout/building";
import { useDepartmentStore } from "@/world/state/departmentStore";
import { useEmployeeStore } from "@/world/state/employeeStore";

import { EmployeeEditor } from "../hq/EmployeeEditor";
import { DepartmentDirectory } from "./DepartmentDirectory";
import { buildOrgTree } from "./orgTree";

const dept = (key: string, position: number, roles: string[], over: Partial<Department> = {}): Department => ({
  key,
  position,
  name: key[0].toUpperCase() + key.slice(1),
  description: `${key} description`,
  responsibilities: ["Do things"],
  roles,
  color: "#22d3ee",
  room_id: null,
  director_id: null,
  max_concurrent_tasks: 2,
  daily_request_budget: 200,
  headcount: 0,
  ...over,
});

const emp = (id: string, name: string, department: string, role: string, supervisor_id: string | null, desk_id: string | null = null): Employee => ({
  id,
  name,
  role,
  department,
  seniority: "mid",
  desk_id,
  supervisor_id,
  avatar_seed: 1,
  status: "idle",
  status_detail: null,
  status_changed_at: "2026-10-08T00:00:00Z",
});

const DEPTS = [
  dept("executive", 1, ["Chief Executive Officer", "Executive Assistant"], { director_id: "ceo" }),
  dept("sales", 2, ["Sales Director", "Account Executive"], { director_id: "sd", room_id: "sales" }),
  dept("finance", 3, ["Chief Financial Officer", "Financial Analyst"], { director_id: "cfo" }),
];
const PEOPLE = [
  emp("ceo", "Aria Vance", "executive", "Chief Executive Officer", null, "executive-desk-1"),
  emp("sd", "Marcus Bell", "sales", "Sales Director", "ceo", "sales-desk-1"),
  emp("ae", "Diego Alvarez", "sales", "Account Executive", "sd", "sales-desk-3"),
  emp("cfo", "Ibrahim Saleh", "finance", "Chief Financial Officer", "ceo"),
];

const initialDepts = useDepartmentStore.getState();
const initialEmps = useEmployeeStore.getState();

beforeEach(() => {
  useDepartmentStore.setState({ ...initialDepts, departments: DEPTS, load: "ready" }, true);
  useEmployeeStore.setState({ ...initialEmps, employees: PEOPLE, load: "ready" }, true);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
});

describe("shared office file", () => {
  it("matches the 3D layout's desks and rooms exactly", () => {
    expect(officeFile.desks.map((d) => [d.id, d.room, d.floor]).sort()).toEqual(WORKSTATIONS.map((w) => [w.id, w.room, w.floor]).sort());
    expect(officeFile.rooms.map((r) => r.id).sort()).toEqual(ROOMS.map((r) => r.id).sort());
  });
});

describe("buildOrgTree", () => {
  it("builds one tree under the CEO with directors first and department order respected", () => {
    const order = new Map(DEPTS.map((d) => [d.key, d.position]));
    const tree = buildOrgTree(PEOPLE, new Set(["ceo", "sd", "cfo"]), order);
    expect(tree.roots.map((r) => r.employee.id)).toEqual(["ceo"]);
    expect(tree.roots[0].reports.map((r) => r.employee.id)).toEqual(["sd", "cfo"]);
    expect(tree.roots[0].size).toBe(3);
    expect(tree.roots[0].reports[0].reports.map((r) => r.employee.id)).toEqual(["ae"]);
    expect(tree.unattached).toEqual([]);
  });

  it("reports people whose manager is missing and survives cycles", () => {
    const orphan = emp("x", "Orphan", "sales", "Account Executive", "ghost");
    const a = emp("a", "A", "sales", "Account Executive", "b");
    const b = emp("b", "B", "sales", "Account Executive", "a");
    const tree = buildOrgTree([...PEOPLE, orphan, a, b]);
    expect(tree.unattached.map((e) => e.id)).toEqual(["x"]);
    expect(tree.roots.map((r) => r.employee.id)).toEqual(["ceo"]);
  });
});

describe("EmployeeEditor", () => {
  it("offers only the chosen department's roles and only free desks", () => {
    render(<EmployeeEditor onClose={() => {}} department="finance" />);
    const dialog = screen.getByTestId("employee-editor");
    const role = within(dialog).getByLabelText("Role") as HTMLSelectElement;
    expect([...role.options].map((o) => o.value)).toEqual(["Chief Financial Officer", "Financial Analyst"]);
    expect(role.value).toBe("Financial Analyst");
    fireEvent.change(within(dialog).getByLabelText("Department"), { target: { value: "sales" } });
    expect([...(within(dialog).getByLabelText("Role") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["Sales Director", "Account Executive"]);
    const desks = [...(within(dialog).getByLabelText("Desk") as HTMLSelectElement).options].map((o) => o.value);
    expect(desks).toContain("");
    expect(desks).toContain("sales-desk-2");
    expect(desks).not.toContain("sales-desk-1"); // taken by Marcus
    expect(desks).not.toContain("executive-desk-1");
  });

  it("hires through the backend and lets it choose the default supervisor", async () => {
    const created = emp("new", "Ada Okoye", "finance", "Financial Analyst", "cfo");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return json(created, 201);
      // The store refreshes after hiring; the backend now lists the new hire.
      return url.includes("departments") ? json(DEPTS) : json([...PEOPLE, created]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    render(<EmployeeEditor onClose={onClose} department="finance" />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada Okoye" } });
    fireEvent.click(screen.getByRole("button", { name: "Hire employee" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "POST")!;
    const body = JSON.parse(String(init!.body));
    expect(body).toEqual({ name: "Ada Okoye", department: "finance", role: "Financial Analyst", seniority: "mid", desk_id: null });
    expect(useEmployeeStore.getState().employees.some((e) => e.id === "new")).toBe(true);
  });

  it("shows the backend's rule violation instead of closing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "Desk 'sales-desk-2' is already taken" }), { status: 409, headers: { "content-type": "application/json" } })),
    );
    const onClose = vi.fn();
    render(<EmployeeEditor employee={PEOPLE[2]} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Desk"), { target: { value: "sales-desk-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already taken");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("confirms before removing and says where reports go", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const onDeleted = vi.fn();
    render(<EmployeeEditor employee={PEOPLE[1]} onClose={() => {}} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove employee…" }));
    expect(screen.getByText(/1 report\(s\) will move to Aria Vance/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Yes, remove" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(useEmployeeStore.getState().employees.some((e) => e.id === "sd")).toBe(false);
  });
});

describe("DepartmentDirectory", () => {
  it("lists departments with directors, headcount and office", () => {
    render(<DepartmentDirectory />);
    const sales = screen.getByRole("link", { name: /Sales/ });
    expect(sales).toHaveAttribute("href", "/departments/sales");
    expect(sales).toHaveTextContent("Marcus Bell");
    expect(sales).toHaveTextContent("Office: Sales");
    expect(screen.getByRole("link", { name: /Finance/ })).toHaveTextContent("No office yet · remote");
    fireEvent.change(screen.getByLabelText("Filter departments"), { target: { value: "analyst" } });
    expect(screen.queryByRole("link", { name: /Sales/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Finance/ })).toBeInTheDocument();
  });
});
