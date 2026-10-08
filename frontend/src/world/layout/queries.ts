import { FLOORS, PLACEMENTS, ROOMS, WALLS, WORKSTATIONS } from "./building";
import type { ActiveFloor, FloorDef, FloorId, FurnitureType, Placement, Rect, RoomDef, WallDef } from "./types";

export const ROOM_BY_ID: ReadonlyMap<string, RoomDef> = new Map(ROOMS.map((r) => [r.id, r]));
export const FLOOR_BY_ID: ReadonlyMap<FloorId, FloorDef> = new Map(FLOORS.map((f) => [f.id, f]));
export const WALL_BY_ID: ReadonlyMap<string, WallDef> = new Map(WALLS.map((w) => [w.id, w]));

export function floorIndex(id: FloorId): number {
  return FLOORS.findIndex((f) => f.id === id);
}

export function rectArea(r: Rect): number {
  return (r.x1 - r.x0) * (r.z1 - r.z0);
}

export function rectIntersection(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x0, b.x0);
  const z0 = Math.max(a.z0, b.z0);
  const x1 = Math.min(a.x1, b.x1);
  const z1 = Math.min(a.z1, b.z1);
  return x1 > x0 && z1 > z0 ? { x0, z0, x1, z1 } : null;
}

export function rectContains(outer: Rect, inner: Rect, epsilon = 1e-6): boolean {
  return (
    inner.x0 >= outer.x0 - epsilon &&
    inner.z0 >= outer.z0 - epsilon &&
    inner.x1 <= outer.x1 + epsilon &&
    inner.z1 <= outer.z1 + epsilon
  );
}

export function rectCenter(r: Rect): [number, number] {
  return [(r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2];
}

/** Floors rendered for the current floor selection (a floor hides those above it). */
export function isFloorVisible(floor: FloorId, active: ActiveFloor): boolean {
  return active === "all" || floorIndex(floor) <= floorIndex(active);
}

/** True when a visible floor above covers at least half of the room. */
export function isRoomCovered(room: RoomDef, active: ActiveFloor): boolean {
  const own = floorIndex(room.floor);
  return FLOORS.some((f, i) => {
    if (i <= own || !isFloorVisible(f.id, active)) return false;
    const overlap = rectIntersection(room.rect, f.footprint);
    return overlap !== null && rectArea(overlap) >= rectArea(room.rect) / 2;
  });
}

/** A room is visible when its floor is shown and nothing above hides it. */
export function isRoomVisible(room: RoomDef, active: ActiveFloor): boolean {
  return isFloorVisible(room.floor, active) && !isRoomCovered(room, active);
}

/** The floor selection needed to see `room`, keeping the current one if it already works. */
export function floorSelectionFor(room: RoomDef, active: ActiveFloor): ActiveFloor {
  return isRoomVisible(room, active) ? active : room.floor;
}

const SEATING: ReadonlySet<FurnitureType> = new Set([
  "chair",
  "execChair",
  "cafeChair",
  "stool",
  "sofa",
  "armchair",
  "beanbag",
]);
const SEATS_PER: Partial<Record<FurnitureType, number>> = { sofa: 3 };

export interface RoomStats {
  workstations: number;
  seats: number;
  area: number;
}

export function roomStats(roomId: string): RoomStats {
  const room = ROOM_BY_ID.get(roomId);
  if (!room) throw new Error(`Unknown room ${roomId}`);
  const seats = PLACEMENTS.filter((p) => p.room === roomId && SEATING.has(p.type)).reduce(
    (sum, p) => sum + (SEATS_PER[p.type] ?? 1),
    0,
  );
  return {
    workstations: WORKSTATIONS.filter((w) => w.room === roomId).length,
    seats,
    area: Math.round(rectArea(room.rect)),
  };
}

export function searchRooms(query: string): RoomDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return ROOMS;
  return ROOMS.filter((r) =>
    [r.name, r.department ?? "", r.kind, FLOOR_BY_ID.get(r.floor)?.shortName ?? ""].some((field) =>
      field.toLowerCase().includes(q),
    ),
  );
}

export function placementsOn(floor: FloorId): Placement[] {
  return PLACEMENTS.filter((p) => p.floor === floor);
}

/** World position and inward tangent for a point `at` metres along a wall. */
export function pointOnWall(wall: WallDef, at: number): { x: number; z: number; dx: number; dz: number } {
  const [ax, az] = wall.from;
  const [bx, bz] = wall.to;
  const length = Math.hypot(bx - ax, bz - az);
  const dx = (bx - ax) / length;
  const dz = (bz - az) / length;
  return { x: ax + dx * at, z: az + dz * at, dx, dz };
}

export function wallLength(wall: WallDef): number {
  return Math.hypot(wall.to[0] - wall.from[0], wall.to[1] - wall.from[1]);
}
