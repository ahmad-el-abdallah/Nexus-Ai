"use client";

import { WORKSTATIONS } from "@/world/layout/building";
import { FLOOR_BY_ID, ROOM_BY_ID, roomStats } from "@/world/layout/queries";
import { useEmployeeStore } from "@/world/state/employeeStore";
import { useOfficeStore } from "@/world/state/officeStore";

import { Initials, StatusBadge } from "./people";

const KIND_LABEL = {
  department: "Department office",
  meeting: "Meeting room",
  reception: "Reception",
  amenity: "Amenity",
} as const;

/** Details of the selected room. Only facts from the layout and real (empty) state. */
export function RoomPanel() {
  const roomId = useOfficeStore((s) => s.selectedRoomId);
  const selectRoom = useOfficeStore((s) => s.selectRoom);
  const selectEmployee = useOfficeStore((s) => s.selectEmployee);
  const employees = useEmployeeStore((s) => s.employees);
  const rosterLoad = useEmployeeStore((s) => s.load);
  const room = roomId ? ROOM_BY_ID.get(roomId) : undefined;
  if (!room) return null;
  const stats = roomStats(room.id);
  const floor = FLOOR_BY_ID.get(room.floor)!;
  const desks = new Set(WORKSTATIONS.filter((w) => w.room === room.id).map((w) => w.id));
  const team = employees.filter((e) => e.desk_id && desks.has(e.desk_id));
  const active = team.filter((e) => e.status !== "suspended" && e.status !== "idle").length;

  const facts: Array<[string, string]> = [
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

      <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-nx-line">
        {facts.map(([label, value]) => (
          <div key={label} className="bg-nx-bg/80 px-4 py-3">
            <dt className="text-[11px] tracking-wider text-nx-faint uppercase">{label}</dt>
            <dd className="mt-1 font-mono text-sm text-nx-text">{value}</dd>
          </div>
        ))}
      </dl>

      {room.kind !== "amenity" && (
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
