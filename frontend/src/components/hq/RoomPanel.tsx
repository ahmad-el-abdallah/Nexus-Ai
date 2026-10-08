"use client";

import { FLOOR_BY_ID, ROOM_BY_ID, roomStats } from "@/world/layout/queries";
import { useOfficeStore } from "@/world/state/officeStore";

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
  const room = roomId ? ROOM_BY_ID.get(roomId) : undefined;
  if (!room) return null;
  const stats = roomStats(room.id);
  const floor = FLOOR_BY_ID.get(room.floor)!;

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
        <section className="mt-5 space-y-2 text-sm">
          <div className="flex items-center justify-between rounded-xl bg-white/[0.03] px-4 py-3 ring-1 ring-nx-line">
            <span className="text-nx-muted">Team</span>
            <span className="text-nx-text">No AI employees assigned yet</span>
          </div>
          <div className="flex items-center justify-between rounded-xl bg-white/[0.03] px-4 py-3 ring-1 ring-nx-line">
            <span className="text-nx-muted">Activity</span>
            <span className="text-nx-text">{room.kind === "meeting" ? "No meetings scheduled" : "No active work"}</span>
          </div>
          <p className="pt-1 text-xs text-nx-faint">
            AI employees take their desks in Stage 3. Departments get their configuration in Stage 4.
          </p>
        </section>
      )}
    </aside>
  );
}
