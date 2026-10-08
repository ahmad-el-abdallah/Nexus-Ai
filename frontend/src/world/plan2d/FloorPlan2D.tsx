"use client";

import { FLOORS, PLACEMENTS, ROOMS, WALLS, WORKSTATIONS } from "../layout/building";
import { NON_BLOCKING, placementBounds } from "../layout/footprints";
import { isFloorVisible, rectCenter } from "../layout/queries";
import type { FloorDef } from "../layout/types";
import { useOfficeStore } from "../state/officeStore";

const PAD = 1.2;

/**
 * Accessible 2D floor plan, generated from the same layout data as the 3D
 * office. Used when WebGL2 is unavailable, or on request.
 */
export function FloorPlan2D() {
  const active = useOfficeStore((s) => s.activeFloor);
  // Show the selected floor, or every floor for the overview.
  const floors = active === "all" ? FLOORS.slice().reverse() : FLOORS.filter((f) => f.id === active);
  return (
    <div data-testid="floor-plan-2d" className="absolute inset-0 overflow-y-auto px-3 pt-32 pb-28 md:px-28 md:pt-24">
      <div className={`mx-auto grid max-w-6xl gap-6 ${floors.length > 1 ? "xl:grid-cols-2" : ""}`}>
        {floors.map((floor) => (
          <FloorSvg key={floor.id} floor={floor} />
        ))}
      </div>
      {active !== "all" && !isFloorVisible("L2", active) && (
        <p className="mx-auto mt-4 max-w-6xl text-center text-xs text-nx-faint">Floors above the selected one are hidden.</p>
      )}
    </div>
  );
}

function FloorSvg({ floor }: { floor: FloorDef }) {
  const selected = useOfficeStore((s) => s.selectedRoomId);
  const hovered = useOfficeStore((s) => s.hoveredRoomId);
  const selectRoom = useOfficeStore((s) => s.selectRoom);
  const hoverRoom = useOfficeStore((s) => s.hoverRoom);
  const { x0, z0, x1, z1 } = floor.footprint;
  const rooms = ROOMS.filter((r) => r.floor === floor.id);
  const desks = new Set(WORKSTATIONS.map((w) => w.id));

  return (
    <figure className="glass p-4">
      <figcaption className="mb-3 flex items-center justify-between text-sm">
        <span className="font-semibold text-nx-text">{floor.name}</span>
        <span className="font-mono text-xs text-nx-faint">
          {(x1 - x0).toFixed(0)} × {(z1 - z0).toFixed(0)} m
        </span>
      </figcaption>
      <svg
        viewBox={`${x0 - PAD} ${z0 - PAD} ${x1 - x0 + PAD * 2} ${z1 - z0 + PAD * 2}`}
        className="h-auto w-full"
        role="group"
        aria-label={`Floor plan: ${floor.name}`}
      >
        {rooms.map((room) => {
          const { x0: rx0, z0: rz0, x1: rx1, z1: rz1 } = room.rect;
          const isSel = selected === room.id;
          const isHov = hovered === room.id;
          const [cx, cz] = rectCenter(room.rect);
          return (
            <g
              key={room.id}
              role="button"
              tabIndex={0}
              aria-label={`${room.name}${isSel ? " (selected)" : ""}`}
              aria-pressed={isSel}
              data-room={room.id}
              className="cursor-pointer outline-none focus-visible:[&>rect]:stroke-white"
              onClick={() => selectRoom(room.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  selectRoom(room.id);
                }
              }}
              onMouseEnter={() => hoverRoom(room.id)}
              onMouseLeave={() => hoverRoom(null)}
            >
              <rect
                x={rx0}
                y={rz0}
                width={rx1 - rx0}
                height={rz1 - rz0}
                fill={room.accent}
                fillOpacity={isSel ? 0.28 : isHov ? 0.2 : 0.1}
                stroke={room.accent}
                strokeOpacity={isSel ? 1 : 0.55}
                strokeWidth={isSel ? 0.18 : 0.08}
              />
              {PLACEMENTS.filter((p) => p.room === room.id && !NON_BLOCKING.has(p.type)).map((p) => {
                const b = placementBounds(p);
                const desk = desks.has(p.id);
                return (
                  <rect
                    key={p.id}
                    x={b.x0}
                    y={b.z0}
                    width={b.x1 - b.x0}
                    height={b.z1 - b.z0}
                    rx={0.08}
                    fill={desk ? "#c8986a" : "#e7eaf6"}
                    fillOpacity={desk ? 0.55 : 0.12}
                    pointerEvents="none"
                  />
                );
              })}
              <text x={cx} y={cz} textAnchor="middle" dominantBaseline="middle" fontSize={0.9} fontWeight={600} fill="#e7eaf6" pointerEvents="none">
                {room.name}
              </text>
            </g>
          );
        })}
        {WALLS.filter((w) => w.floor === floor.id).map((w) => (
          <line
            key={w.id}
            x1={w.from[0]}
            y1={w.from[1]}
            x2={w.to[0]}
            y2={w.to[1]}
            stroke={w.kind === "glass" || w.kind === "storefront" || w.kind === "railing" ? "#7dd3fc" : "#8a95c7"}
            strokeWidth={w.kind === "exterior" || w.kind === "solid" ? 0.24 : 0.08}
            strokeDasharray={w.kind === "railing" ? "0.4 0.3" : undefined}
            pointerEvents="none"
          />
        ))}
      </svg>
      <p className="mt-2 text-[11px] text-nx-faint">Desks are shown in wood; select a room for details.</p>
    </figure>
  );
}
