/** Client for departments (`/api/departments`). */

import { request } from "./employees";

export interface Department {
  key: string;
  position: number;
  name: string;
  description: string;
  responsibilities: string[];
  /** Role titles; the first is the director role. */
  roles: string[];
  color: string;
  room_id: string | null;
  director_id: string | null;
  model_id?: string | null;
  max_concurrent_tasks: number;
  daily_request_budget: number;
  headcount: number;
}

export type DepartmentConfig = Partial<
  Pick<Department, "name" | "description" | "color" | "room_id" | "director_id" | "model_id" | "max_concurrent_tasks" | "daily_request_budget">
>;

export const fetchDepartments = () => request<Department[]>("/api/departments");
export const configureDepartment = (key: string, config: DepartmentConfig) =>
  request<Department>(`/api/departments/${key}`, { method: "PATCH", body: JSON.stringify(config) });
