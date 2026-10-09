import { describe, expect, it } from "vitest";

import { FLOORS, PLACEMENTS, PLINTH, ROOMS, WALL_ITEMS, WALLS, WORKSTATIONS } from "./building";
import { FOOTPRINTS, NON_BLOCKING, placementBounds, SEATING_TYPES, TABLE_TYPES } from "./footprints";
import {
  floorSelectionFor,
  isFloorVisible,
  isRoomCovered,
  isRoomVisible,
  pointOnWall,
  rectArea,
  rectContains,
  rectIntersection,
  ROOM_BY_ID,
  roomStats,
  searchRooms,
  wallLength,
} from "./queries";
import type { Placement, Rect } from "./types";

const overlaps = (a: Rect, b: Rect, eps = 0.01) =>
  a.x0 < b.x1 - eps && b.x0 < a.x1 - eps && a.z0 < b.z1 - eps && b.z0 < a.z1 - eps;

describe("headquarters layout", () => {
  it("contains every room Stage 2 requires", () => {
    const required = ["reception", "executive", "marketing", "engineering", "sales", "meeting", "data-center"];
    for (const id of required) expect(ROOM_BY_ID.has(id), id).toBe(true);
  });

  it("uses unique ids everywhere", () => {
    for (const list of [ROOMS, WALLS, WALL_ITEMS, PLACEMENTS, WORKSTATIONS]) {
      const ids = list.map((x) => x.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("keeps every room inside its floor and never overlaps rooms on a floor", () => {
    for (const room of ROOMS) {
      const floor = FLOORS.find((f) => f.id === room.floor)!;
      expect(rectContains(floor.footprint, room.rect), room.id).toBe(true);
    }
    for (const a of ROOMS) {
      for (const b of ROOMS) {
        if (a.id >= b.id || a.floor !== b.floor) continue;
        expect(rectIntersection(a.rect, b.rect), `${a.id} vs ${b.id}`).toBeNull();
      }
    }
  });

  it("tiles each floor completely with rooms", () => {
    for (const floor of FLOORS) {
      const covered = ROOMS.filter((r) => r.floor === floor.id).reduce((s, r) => s + rectArea(r.rect), 0);
      expect(covered).toBeCloseTo(rectArea(floor.footprint));
    }
  });

  it("places all furniture inside its room (or on the outdoor plinth)", () => {
    for (const p of PLACEMENTS) {
      const bounds = placementBounds(p);
      const container = p.room ? ROOM_BY_ID.get(p.room)!.rect : PLINTH;
      expect(rectContains(container, bounds), `${p.id} at ${p.x},${p.z}`).toBe(true);
    }
  });

  it("never stacks furniture, except seats tucked under tables", () => {
    const blocking = PLACEMENTS.filter((p) => !NON_BLOCKING.has(p.type));
    const tucked = (a: Placement, b: Placement) =>
      (SEATING_TYPES.has(a.type) && TABLE_TYPES.has(b.type)) ||
      (SEATING_TYPES.has(b.type) && TABLE_TYPES.has(a.type));
    expect(blocking.length).toBeGreaterThan(120);
    const clashes: string[] = [];
    for (let i = 0; i < blocking.length; i++) {
      for (let j = i + 1; j < blocking.length; j++) {
        const a = blocking[i];
        const b = blocking[j];
        if (a.floor !== b.floor || tucked(a, b)) continue;
        if (overlaps(placementBounds(a), placementBounds(b))) clashes.push(`${a.id} × ${b.id}`);
      }
    }
    expect(clashes).toEqual([]);
  });

  it("keeps a clear metre in front of and behind every door", () => {
    const blocked: string[] = [];
    let zones = 0;
    for (const wall of WALLS) {
      for (const opening of wall.openings ?? []) {
        zones++;
        const p = pointOnWall(wall, opening.at);
        const half = opening.width / 2;
        // Clearance zone: the opening's width along the wall, ±1 m across it.
        const alongX = Math.abs(p.dx) > 0.5;
        const zone: Rect = alongX
          ? { x0: p.x - half, x1: p.x + half, z0: p.z - 1, z1: p.z + 1 }
          : { x0: p.x - 1, x1: p.x + 1, z0: p.z - half, z1: p.z + half };
        for (const item of PLACEMENTS) {
          if (item.floor !== wall.floor || NON_BLOCKING.has(item.type)) continue;
          if (overlaps(zone, placementBounds(item))) blocked.push(`${wall.id}@${opening.at} by ${item.id}`);
        }
      }
    }
    expect(zones).toBe(13);
    expect(blocked).toEqual([]);
  });

  it("keeps openings and wall items within their walls and items clear of openings", () => {
    for (const wall of WALLS) {
      const length = wallLength(wall);
      for (const o of wall.openings ?? []) {
        expect(o.at - o.width / 2).toBeGreaterThan(0.2);
        expect(o.at + o.width / 2).toBeLessThan(length - 0.2);
      }
    }
    for (const item of WALL_ITEMS) {
      const wall = WALLS.find((w) => w.id === item.wall);
      expect(wall, item.id).toBeDefined();
      const length = wallLength(wall!);
      expect(item.at - item.width / 2, item.id).toBeGreaterThanOrEqual(0);
      expect(item.at + item.width / 2, item.id).toBeLessThanOrEqual(length);
      for (const o of wall!.openings ?? []) {
        const gap = Math.abs(item.at - o.at) - (item.width + o.width) / 2;
        expect(gap, `${item.id} vs opening at ${o.at}`).toBeGreaterThan(0);
      }
    }
  });

  it("has a footprint for every furniture type in use", () => {
    for (const p of PLACEMENTS) expect(FOOTPRINTS[p.type], p.type).toBeDefined();
  });

  it("assigns every workstation to a department, meeting or reception room on its floor", () => {
    for (const ws of WORKSTATIONS) {
      const room = ROOM_BY_ID.get(ws.room);
      expect(room, ws.id).toBeDefined();
      expect(room!.floor).toBe(ws.floor);
      expect(room!.kind).not.toBe("amenity");
    }
  });

  it("reports room statistics from the layout itself", () => {
    expect(roomStats("engineering").workstations).toBe(12);
    expect(roomStats("sales").workstations).toBe(8);
    expect(roomStats("marketing").workstations).toBe(6);
    expect(roomStats("executive").workstations).toBe(1);
    expect(roomStats("meeting").seats).toBe(9);
    expect(roomStats("meeting").workstations).toBe(0);
    expect(roomStats("engineering").area).toBe(130);
    expect(roomStats("data-center").area).toBe(62);
    expect(PLACEMENTS.filter((p) => p.room === "data-center" && p.type === "serverRack")).toHaveLength(12);
  });
});

describe("floor visibility", () => {
  const room = (id: string) => ROOM_BY_ID.get(id)!;

  it("hides floors above the selected one", () => {
    expect(isFloorVisible("L2", "all")).toBe(true);
    expect(isFloorVisible("L2", "L1")).toBe(false);
    expect(isFloorVisible("L1", "L2")).toBe(true);
  });

  it("treats ground-floor rooms under level 2 as covered in the overview", () => {
    expect(isRoomCovered(room("lounge"), "all")).toBe(true);
    expect(isRoomCovered(room("cafe"), "all")).toBe(true);
    expect(isRoomCovered(room("reception"), "all")).toBe(false);
    expect(isRoomVisible(room("lounge"), "L1")).toBe(true);
  });

  it("switches floors only when needed to reveal a room", () => {
    expect(floorSelectionFor(room("engineering"), "all")).toBe("all");
    expect(floorSelectionFor(room("sales"), "all")).toBe("all");
    expect(floorSelectionFor(room("lounge"), "all")).toBe("L1");
    expect(floorSelectionFor(room("engineering"), "L1")).toBe("L2");
  });
});

describe("room search", () => {
  it("matches names, departments, kinds and floors", () => {
    expect(searchRooms("eng").map((r) => r.id)).toEqual(["engineering"]);
    expect(searchRooms("SALES").map((r) => r.id)).toEqual(["sales"]);
    expect(searchRooms("amenity").map((r) => r.id).sort()).toEqual(["cafe", "lounge"]);
    expect(searchRooms("level 2").length).toBe(4);
    expect(searchRooms("  ").length).toBe(ROOMS.length);
    expect(searchRooms("zzz")).toEqual([]);
  });
});
