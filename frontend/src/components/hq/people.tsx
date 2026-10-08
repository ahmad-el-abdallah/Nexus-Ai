"use client";

import type { Department } from "@/lib/departments";
import type { Employee } from "@/lib/employees";
import { initials } from "@/world/characters/appearance";
import { STATUS_META } from "@/world/characters/status";
import { useDepartment } from "@/world/state/departmentStore";

const FALLBACK_COLOR = "#94a3b8";

/** Display name and colour of a department (from the backend once loaded). */
export function departmentMeta(key: string, departments: Department[]): { name: string; color: string } {
  const d = departments.find((x) => x.key === key);
  return { name: d?.name ?? key, color: d?.color ?? FALLBACK_COLOR };
}

export function useDepartmentMeta(key: string) {
  const d = useDepartment(key);
  return { name: d?.name ?? key, color: d?.color ?? FALLBACK_COLOR };
}

export function Initials({ employee, size = "size-9" }: { employee: Employee; size?: string }) {
  const { color } = useDepartmentMeta(employee.department);
  return (
    <span
      aria-hidden
      className={`${size} grid shrink-0 place-items-center rounded-full text-xs font-bold text-nx-bg`}
      style={{ background: color, boxShadow: `0 0 12px ${color}55` }}
    >
      {initials(employee.name)}
    </span>
  );
}

export function StatusBadge({ employee }: { employee: Employee }) {
  const meta = STATUS_META[employee.status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-nx-muted">
      <span className="size-2 rounded-full" style={{ background: meta.color, boxShadow: `0 0 8px ${meta.color}` }} />
      {meta.label}
    </span>
  );
}

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
