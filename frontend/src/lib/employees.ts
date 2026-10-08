/** Client for the AI employee roster (`/api/employees`). */

export type EmployeeStatus =
  | "idle"
  | "assigned"
  | "working"
  | "researching"
  | "meeting"
  | "reviewing"
  | "blocked"
  | "completed"
  | "error"
  | "suspended";

export interface Employee {
  id: string;
  name: string;
  role: string;
  department: string;
  seniority: string;
  desk_id: string | null;
  avatar_seed: number;
  status: EmployeeStatus;
  status_detail: string | null;
  status_changed_at: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", headers: { Accept: "application/json" }, ...init });
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await response.json() : null;
  if (!response.ok) {
    const detail = body && typeof body.detail === "string" ? body.detail : `Request failed (${response.status})`;
    throw new ApiError(detail, response.status);
  }
  if (!isJson) throw new ApiError("Backend is unreachable", response.status);
  return body as T;
}

export const fetchEmployees = () => request<Employee[]>("/api/employees");
export const suspendEmployee = (id: string) => request<Employee>(`/api/employees/${id}/suspend`, { method: "POST" });
export const activateEmployee = (id: string) => request<Employee>(`/api/employees/${id}/activate`, { method: "POST" });
