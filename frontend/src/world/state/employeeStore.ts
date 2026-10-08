import { create } from "zustand";

import {
  activateEmployee,
  createEmployee,
  deleteEmployee,
  type Employee,
  type EmployeeDraft,
  fetchEmployees,
  suspendEmployee,
  updateEmployee,
} from "@/lib/employees";

import { useDepartmentStore } from "./departmentStore";

export const EMPLOYEE_POLL_MS = 5_000;

type LoadState = "idle" | "loading" | "ready" | "error";

export interface EmployeeState {
  employees: Employee[];
  load: LoadState;
  error: string | null;
  /** Employee ids with an owner action in flight. */
  pending: Record<string, boolean>;
  actionError: Record<string, string>;
  refresh: () => Promise<void>;
  setAvailability: (id: string, action: "suspend" | "activate") => Promise<void>;
  /** Owner actions; they throw with the backend's message when a rule is broken. */
  hire: (draft: EmployeeDraft) => Promise<Employee>;
  edit: (id: string, changes: Partial<EmployeeDraft>) => Promise<Employee>;
  remove: (id: string) => Promise<void>;
}

function replace(list: Employee[], updated: Employee): Employee[] {
  return list.map((e) => (e.id === updated.id ? updated : e));
}

export const useEmployeeStore = create<EmployeeState>((set, get) => ({
  employees: [],
  load: "idle",
  error: null,
  pending: {},
  actionError: {},

  refresh: async () => {
    if (get().load === "idle") set({ load: "loading" });
    try {
      const employees = await fetchEmployees();
      if (!Array.isArray(employees)) throw new Error("Unexpected roster response");
      const current = get().employees;
      // Avoid re-rendering the world when nothing changed.
      const same = current.length === employees.length && JSON.stringify(current) === JSON.stringify(employees);
      set(same ? { load: "ready", error: null } : { employees, load: "ready", error: null });
    } catch (error) {
      set({ load: "error", error: (error as Error).message });
    }
  },

  hire: async (draft) => {
    const created = await createEmployee(draft);
    set({ employees: [...get().employees, created] });
    // Other people's reporting lines and department headcounts may have changed.
    void get().refresh();
    void useDepartmentStore.getState().refresh();
    return created;
  },

  edit: async (id, changes) => {
    const updated = await updateEmployee(id, changes);
    set({ employees: replace(get().employees, updated) });
    void get().refresh();
    void useDepartmentStore.getState().refresh();
    return updated;
  },

  remove: async (id) => {
    await deleteEmployee(id);
    set({ employees: get().employees.filter((e) => e.id !== id) });
    void get().refresh();
    void useDepartmentStore.getState().refresh();
  },

  setAvailability: async (id, action) => {
    set({ pending: { ...get().pending, [id]: true }, actionError: { ...get().actionError, [id]: "" } });
    try {
      const updated = await (action === "suspend" ? suspendEmployee(id) : activateEmployee(id));
      set({ employees: replace(get().employees, updated) });
    } catch (error) {
      set({ actionError: { ...get().actionError, [id]: (error as Error).message } });
    } finally {
      const pending = { ...get().pending };
      delete pending[id];
      set({ pending });
    }
  },
}));

/** Starts polling the roster and departments; returns a stop function. */
export function startEmployeePolling(intervalMs = EMPLOYEE_POLL_MS): () => void {
  const tick = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    void useEmployeeStore.getState().refresh();
    void useDepartmentStore.getState().refresh();
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  const onVisible = () => document.visibilityState === "visible" && tick();
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
