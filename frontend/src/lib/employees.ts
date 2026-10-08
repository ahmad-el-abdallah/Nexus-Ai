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
  supervisor_id: string | null;
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

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init?.body) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { cache: "no-store", ...init, headers });
  if (response.status === 204) return undefined as T;
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await response.json() : null;
  if (!response.ok) {
    const detail =
      body && typeof body.detail === "string"
        ? body.detail
        : body && Array.isArray(body.detail)
          ? body.detail.map((d: { msg?: string }) => d.msg).join("; ")
          : `Request failed (${response.status})`;
    throw new ApiError(detail, response.status);
  }
  if (!isJson) throw new ApiError("Backend is unreachable", response.status);
  return body as T;
}

export const fetchEmployees = () => request<Employee[]>("/api/employees");
export const suspendEmployee = (id: string) => request<Employee>(`/api/employees/${id}/suspend`, { method: "POST" });
export const activateEmployee = (id: string) => request<Employee>(`/api/employees/${id}/activate`, { method: "POST" });

export type Seniority = "executive" | "director" | "senior" | "mid" | "junior";
export const SENIORITY: Seniority[] = ["executive", "director", "senior", "mid", "junior"];

export interface EmployeeDraft {
  name: string;
  department: string;
  role: string;
  seniority: Seniority;
  desk_id: string | null;
  supervisor_id?: string | null;
}

export const createEmployee = (draft: EmployeeDraft) =>
  request<Employee>("/api/employees", { method: "POST", body: JSON.stringify(draft) });
export const updateEmployee = (id: string, changes: Partial<EmployeeDraft>) =>
  request<Employee>(`/api/employees/${id}`, { method: "PATCH", body: JSON.stringify(changes) });
export const deleteEmployee = (id: string) => request<void>(`/api/employees/${id}`, { method: "DELETE" });
