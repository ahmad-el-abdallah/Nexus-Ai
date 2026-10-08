/**
 * Typed client for the NEXUS AI backend.
 *
 * All requests are same-origin (`/api/*`); Next.js proxies them to FastAPI, so
 * the browser never needs the backend address or any credentials.
 */

export type ComponentStatus = "ok" | "error" | "migrations_pending" | "planned";

export interface HealthComponent {
  status: ComponentStatus;
  detail: string | null;
  critical: boolean;
  data: Record<string, unknown>;
}

export interface Readiness {
  status: "ok" | "degraded";
  checked_at: string;
  components: Record<string, HealthComponent>;
}

export interface SystemInfo {
  name: string;
  version: string;
  environment: string;
  installation_id: string | null;
  started_at: string;
  uptime_seconds: number;
  database_dialect: string;
  nvidia_key_present: boolean;
}

export class BackendUnavailableError extends Error {
  constructor(message = "Backend is unreachable") {
    super(message);
    this.name = "BackendUnavailableError";
  }
}

async function getJson(path: string, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(path, { signal, cache: "no-store", headers: { Accept: "application/json" } });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new BackendUnavailableError();
  }
  const isJson = response.headers.get("content-type")?.includes("application/json");
  if (!isJson) {
    // The proxy answers with a non-JSON error page when FastAPI is not running.
    throw new BackendUnavailableError(`Unexpected ${response.status} response from ${path}`);
  }
  return { status: response.status, body: await response.json() };
}

function isReadiness(body: unknown): body is Readiness {
  return typeof body === "object" && body !== null && "components" in body && "status" in body;
}

/** Readiness returns 503 with a full body when degraded; both are valid answers. */
export async function fetchReadiness(signal?: AbortSignal): Promise<Readiness> {
  const { body } = await getJson("/api/health/ready", signal);
  if (!isReadiness(body)) throw new BackendUnavailableError("Malformed readiness response");
  return body;
}

export async function fetchSystemInfo(signal?: AbortSignal): Promise<SystemInfo> {
  const { status, body } = await getJson("/api/system/info", signal);
  if (status !== 200) throw new BackendUnavailableError(`System info returned ${status}`);
  return body as SystemInfo;
}
