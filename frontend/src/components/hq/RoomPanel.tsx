"use client";

import Link from "next/link";
import { useEffect } from "react";

import { PLACEMENTS, WORKSTATIONS } from "@/world/layout/building";
import { FLOOR_BY_ID, ROOM_BY_ID, roomStats } from "@/world/layout/queries";
import { chatHref } from "@/lib/routing";
import { useDepartmentStore } from "@/world/state/departmentStore";
import { useEmployeeStore } from "@/world/state/employeeStore";
import { useOfficeStore } from "@/world/state/officeStore";
import { useStorageStore } from "@/world/state/storageStore";

import { Initials, StatusBadge } from "./people";

const KIND_LABEL = {
  department: "Department office",
  meeting: "Meeting room",
  reception: "Reception",
  amenity: "Amenity",
  infrastructure: "Infrastructure",
} as const;

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = value / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && amount >= 1024; i++) {
    amount /= 1024;
    unit = units[i]!;
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function DataCenterStatus() {
  const overview = useStorageStore((s) => s.overview);
  const load = useStorageStore((s) => s.load);
  const error = useStorageStore((s) => s.error);
  const refresh = useStorageStore((s) => s.refresh);

  if (load === "idle" || load === "loading") {
    return <p role="status" className="mt-5 rounded-xl bg-white/[0.03] px-4 py-4 text-sm text-nx-muted ring-1 ring-nx-line">Reading storage metadata…</p>;
  }
  if (load === "error" || !overview) {
    return (
      <section className="mt-5 rounded-xl bg-nx-error/10 p-4 text-sm ring-1 ring-nx-error/30" aria-label="Storage status">
        <p className="font-medium text-nx-error">Storage status unavailable</p>
        <p className="mt-1 text-nx-muted">{error ?? "The backend did not return storage metadata."}</p>
        <button type="button" onClick={() => void refresh()} className="mt-3 rounded-lg px-3 py-1.5 text-xs text-nx-text ring-1 ring-nx-line-strong hover:bg-white/5">Retry</button>
      </section>
    );
  }

  const facts: Array<[string, string]> = [
    ["Workspaces", String(overview.workspace_count)],
    ["Departments", String(overview.department_workspace_count)],
    ["Files", String(overview.file_count)],
    ["Versions", String(overview.version_count)],
    ["Stored", bytes(overview.stored_bytes)],
    ["Dept. quota", bytes(overview.quota_bytes_per_department)],
  ];
  return (
    <section className="mt-5" aria-label="Storage status" data-testid="storage-overview">
      <div className="flex items-center justify-between gap-3 rounded-xl bg-nx-violet/10 px-4 py-3 ring-1 ring-nx-violet/30">
        <span className="flex items-center gap-2 text-sm font-medium text-nx-text">
          <span className="size-2 rounded-full bg-nx-cyan shadow-[0_0_10px_rgb(34_211_238/0.8)]" />
          Metadata online
        </span>
        <span className="font-mono text-[11px] tracking-wider text-nx-muted uppercase">{overview.backend}</span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-nx-line">
        {facts.map(([label, value]) => (
          <div key={label} className="bg-nx-bg/80 px-4 py-3">
            <dt className="text-[10px] tracking-wider text-nx-faint uppercase">{label}</dt>
            <dd className="mt-1 font-mono text-sm text-nx-text">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 rounded-xl bg-white/[0.03] px-4 py-3 text-xs leading-5 text-nx-muted ring-1 ring-nx-line">
        <p>{overview.last_event_at ? "Storage activity is recorded in the audit log." : "No storage activity has been recorded yet."}</p>
        <p>{overview.backup_configured ? "A backup destination is configured; restore verification is still pending." : "No backup destination is configured."}</p>
      </div>
      <button type="button" disabled className="mt-3 w-full cursor-not-allowed rounded-xl bg-white/[0.03] px-4 py-3 text-sm text-nx-faint ring-1 ring-nx-line" title="File operations arrive in the next approved storage stage">
        Digital Vault file operations · Not available yet
      </button>
    </section>
  );
}

/** Details of the selected room. Only facts from the layout and real (empty) state. */
export function RoomPanel() {
  const roomId = useOfficeStore((s) => s.selectedRoomId);
  const selectRoom = useOfficeStore((s) => s.selectRoom);
  const selectEmployee = useOfficeStore((s) => s.selectEmployee);
  const employees = useEmployeeStore((s) => s.employees);
  const rosterLoad = useEmployeeStore((s) => s.load);
  const departments = useDepartmentStore((s) => s.departments);
  const refreshStorage = useStorageStore((s) => s.refresh);
  useEffect(() => {
    if (roomId === "data-center") void refreshStorage();
  }, [roomId, refreshStorage]);
  const room = roomId ? ROOM_BY_ID.get(roomId) : undefined;
  if (!room) return null;
  const stats = roomStats(room.id);
  const floor = FLOOR_BY_ID.get(room.floor)!;
  const desks = new Set(WORKSTATIONS.filter((w) => w.room === room.id).map((w) => w.id));
  const team = employees.filter((e) => e.desk_id && desks.has(e.desk_id));
  const active = team.filter((e) => e.status !== "suspended" && e.status !== "idle").length;

  const racks = PLACEMENTS.filter((p) => p.room === room.id && p.type === "serverRack").length;
  const facts: Array<[string, string]> =
    room.kind === "infrastructure"
      ? [
          ["Floor", floor.shortName],
          ["Area", `${stats.area} m²`],
          ["Racks", String(racks)],
          ["View", "Read-only"],
        ]
      : [
          ["Floor", floor.shortName],
          ["Area", `${stats.area} m²`],
          ["Workstations", String(stats.workstations)],
          ["Seating", String(stats.seats)],
        ];

  return (
    <aside
      aria-label={`${room.name} details`}
      data-testid="room-panel"
      className="glass-solid pointer-events-auto fixed inset-x-3 bottom-3 z-30 max-h-[44vh] overflow-y-auto p-5 md:inset-x-auto md:top-20 md:right-4 md:bottom-auto md:max-h-[calc(100vh-7rem)] md:w-[360px]"
    >
      <div className="mb-4 h-1 w-12 rounded-full" style={{ background: room.accent, boxShadow: `0 0 16px ${room.accent}` }} />
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold tracking-wider text-nx-faint uppercase">{KIND_LABEL[room.kind]}</p>
          <h2 className="mt-1 text-xl font-semibold text-nx-text">{room.name}</h2>
        </div>
        <button
          type="button"
          onClick={() => selectRoom(null)}
          aria-label="Close room details"
          className="grid size-8 place-items-center rounded-lg text-nx-muted ring-1 ring-nx-line-strong transition hover:bg-white/5 hover:text-nx-text"
        >
          ×
        </button>
      </header>
      <p className="mt-3 text-sm leading-6 text-nx-muted">{room.description}</p>
      {departments.some((d) => d.room_id === room.id) && (
        <p className="mt-3 flex flex-wrap gap-2 text-xs">
          {departments
            .filter((d) => d.room_id === room.id)
            .map((d) => (
              <Link
                key={d.key}
                href={`/departments/${d.key}`}
                className="rounded-full px-2.5 py-1 font-medium ring-1 hover:bg-white/5"
                style={{ color: d.color, borderColor: d.color }}
              >
                {d.name} department →
              </Link>
            ))}
          {departments
            .filter((d) => d.room_id === room.id)
            .map((d) => (
              <Link key={`chat-${d.key}`} href={chatHref({ kind: "department", department: d.key })} className="rounded-full bg-nx-violet/20 px-2.5 py-1 font-medium text-nx-text ring-1 ring-nx-violet/50 hover:bg-nx-violet/30">
                Message {d.name}
              </Link>
            ))}
        </p>
      )}

      <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-nx-line">
        {facts.map(([label, value]) => (
          <div key={label} className="bg-nx-bg/80 px-4 py-3">
            <dt className="text-[11px] tracking-wider text-nx-faint uppercase">{label}</dt>
            <dd className="mt-1 font-mono text-sm text-nx-text">{value}</dd>
          </div>
        ))}
      </dl>

      {room.kind === "infrastructure" && <DataCenterStatus />}

      {room.kind !== "amenity" && room.kind !== "infrastructure" && (
        <section className="mt-5 space-y-2 text-sm" aria-label="Team">
          {room.kind !== "meeting" && (
            <div className="rounded-xl bg-white/[0.03] ring-1 ring-nx-line">
              <p className="flex items-center justify-between px-4 pt-3 text-nx-muted">
                <span>Team</span>
                <span className="font-mono text-xs text-nx-faint">
                  {team.length} of {desks.size} desks filled
                </span>
              </p>
              {team.length === 0 ? (
                <p className="px-4 py-3 text-nx-text">
                  {rosterLoad === "error" ? "Roster unavailable (backend offline)" : "No AI employees assigned yet"}
                </p>
              ) : (
                <ul className="py-1.5">
                  {team.map((e) => (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => selectEmployee(e.id)}
                        className="flex w-full items-center gap-3 px-4 py-2 text-left transition hover:bg-white/[0.04]"
                      >
                        <Initials employee={e} size="size-8" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-nx-text">{e.name}</span>
                          <span className="block truncate text-xs text-nx-faint">{e.role}</span>
                        </span>
                        <StatusBadge employee={e} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="flex items-center justify-between rounded-xl bg-white/[0.03] px-4 py-3 ring-1 ring-nx-line">
            <span className="text-nx-muted">Activity</span>
            <span className="text-nx-text">
              {room.kind === "meeting" ? "No meetings scheduled" : active > 0 ? `${active} working` : "No active work"}
            </span>
          </div>
        </section>
      )}
    </aside>
  );
}
