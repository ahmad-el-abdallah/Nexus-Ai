import { create } from "zustand";

import { configureDepartment, type Department, type DepartmentConfig, fetchDepartments } from "@/lib/departments";

export interface DepartmentState {
  departments: Department[];
  load: "idle" | "loading" | "ready" | "error";
  error: string | null;
  refresh: () => Promise<void>;
  configure: (key: string, config: DepartmentConfig) => Promise<Department>;
}

export const useDepartmentStore = create<DepartmentState>((set, get) => ({
  departments: [],
  load: "idle",
  error: null,
  refresh: async () => {
    if (get().load === "idle") set({ load: "loading" });
    try {
      const departments = await fetchDepartments();
      if (!Array.isArray(departments)) throw new Error("Unexpected departments response");
      const same = JSON.stringify(departments) === JSON.stringify(get().departments);
      set(same ? { load: "ready", error: null } : { departments, load: "ready", error: null });
    } catch (error) {
      set({ load: "error", error: (error as Error).message });
    }
  },
  configure: async (key, config) => {
    const updated = await configureDepartment(key, config);
    set({ departments: get().departments.map((d) => (d.key === key ? updated : d)) });
    return updated;
  },
}));

/** Department lookup by key, with a neutral fallback while loading. */
export function useDepartment(key: string | null | undefined): Department | undefined {
  return useDepartmentStore((s) => (key ? s.departments.find((d) => d.key === key) : undefined));
}
