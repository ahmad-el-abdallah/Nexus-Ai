import { Vector3 } from "three";
import { describe, expect, it } from "vitest";

import type { Employee, EmployeeStatus } from "@/lib/employees";

import { WORKSTATIONS } from "../layout/building";
import type { FloorId } from "../layout/types";
import { generateAppearance, initials, SKIN_TONES } from "./appearance";
import { approachPoint, CharacterController } from "./controller";
import { AMBIENT_SPOTS, ELEVATOR_SPOT, navGrid } from "./navigation";
import { PART_SPECS, partGeometry } from "./parts";
import { activityPose, jointMatrices, RIG, walkPose } from "./rig";
import { STATUS_META } from "./status";
import { DESK_SEATS, MEETING_SEATS, OfficeWorld } from "./world";

const pos = (m: { elements: number[] }) => new Vector3(m.elements[12], m.elements[13], m.elements[14]);

describe("appearance generator", () => {
  it("is deterministic per seed", () => {
    expect(generateAppearance(42, "sales")).toEqual(generateAppearance(42, "sales"));
    expect(generateAppearance(42, "sales")).not.toEqual(generateAppearance(43, "sales"));
  });

  it("produces a varied, inclusive crowd", () => {
    const crowd = Array.from({ length: 200 }, (_, i) => generateAppearance(i + 1, "engineering"));
    expect(new Set(crowd.map((a) => a.hairStyle)).size).toBeGreaterThanOrEqual(8);
    expect(new Set(crowd.map((a) => a.skin)).size).toBe(SKIN_TONES.length);
    expect(new Set(crowd.map((a) => a.top)).size).toBe(4);
    expect(crowd.some((a) => a.glasses)).toBe(true);
    expect(crowd.some((a) => a.beard)).toBe(true);
    for (const a of crowd) {
      expect(a.height).toBeGreaterThanOrEqual(0.94);
      expect(a.height).toBeLessThanOrEqual(1.06);
    }
  });

  it("makes initials", () => {
    expect(initials("Aria Vance")).toBe("AV");
    expect(initials("Cher")).toBe("C");
  });
});

describe("character parts", () => {
  it("builds every part (bald hair is intentionally empty)", () => {
    for (const spec of PART_SPECS) {
      const g = partGeometry(spec);
      if (spec.key === "hair-bald") expect(g).toBeNull();
      else expect(g, spec.key).not.toBeNull();
    }
  });
});

describe("rig", () => {
  const joints = (activity: Parameters<typeof activityPose>[0]) => jointMatrices(activityPose(activity, 1, 3), 0, 0, 0, 0, 1, 1);

  it("stands with feet on the floor and the head at adult height", () => {
    const j = joints("standIdle");
    expect(pos(j.footL).y).toBeGreaterThan(0.04);
    expect(pos(j.footL).y).toBeLessThan(0.1);
    expect(pos(j.head).y).toBeGreaterThan(1.4);
    expect(pos(j.head).y).toBeLessThan(1.55);
  });

  it("sits on the chair with feet down", () => {
    const j = joints("sitIdle");
    expect(pos(j.pelvis).y).toBeCloseTo(RIG.seatHeight, 2);
    expect(pos(j.footL).y).toBeLessThan(0.15);
    expect(pos(j.footL).z).toBeGreaterThan(0.25); // knees forward, feet in front
  });

  it("reaches the keyboard when typing", () => {
    const j = joints("sitTyping");
    for (const hand of [j.handL, j.handR]) {
      const p = pos(hand);
      expect(p.y).toBeGreaterThan(0.68);
      expect(p.y).toBeLessThan(0.95);
      expect(p.z).toBeGreaterThan(0.3);
    }
  });

  it("swings legs in opposition while walking", () => {
    const p = walkPose(Math.PI / 2);
    expect(p.legL[0]).toBeGreaterThan(0);
    expect(p.legR[0]).toBeLessThan(0);
    const m = jointMatrices(p, 0, 0, 0, 0, 1, 1);
    for (const v of Object.values(m)) for (const e of v.elements) expect(Number.isFinite(e)).toBe(true);
  });

  it("maps every status to a pose and location", () => {
    for (const [status, meta] of Object.entries(STATUS_META)) {
      expect(["desk", "meeting", "away"]).toContain(meta.location);
      expect(activityPose(meta.activity, 0, 1).pelvisY, status).toBeGreaterThan(0);
    }
  });
});

describe("navigation", () => {
  it("lets every desk and break spot reach the elevator", () => {
    for (const ws of WORKSTATIONS) {
      const seat = DESK_SEATS.get(ws.id)!;
      const grid = navGrid(ws.floor);
      expect(grid.isPointWalkable(approachPoint(seat)), `${ws.id} approach`).toBe(true);
      const path = grid.findPath(approachPoint(seat), ELEVATOR_SPOT);
      expect(path, ws.id).not.toBeNull();
      for (let i = 1; i < path!.length - 1; i++) expect(grid.lineOfSight(path![i - 1], path![i])).toBe(true);
    }
    for (const floor of ["L1", "L2"] as FloorId[]) {
      for (const spot of AMBIENT_SPOTS[floor]) {
        expect(navGrid(floor).isPointWalkable(spot), `${floor} ${spot.label}`).toBe(true);
        expect(navGrid(floor).findPath(spot, ELEVATOR_SPOT)).not.toBeNull();
      }
    }
  });

  it("routes around walls instead of through them", () => {
    // Sales → reception crosses a glass partition, so the path must use its door.
    const grid = navGrid("L1");
    const path = grid.findPath({ x: -10, z: 9.5 }, { x: 0, z: 7.5 })!;
    expect(path.length).toBeGreaterThan(2);
    expect(grid.lineOfSight({ x: -10, z: 9.5 }, { x: 0, z: 2.0 })).toBe(false);
  });

  it("gives every meeting chair a reachable approach", () => {
    for (const seat of MEETING_SEATS) expect(navGrid("L2").findPath(approachPoint(seat), ELEVATOR_SPOT)).not.toBeNull();
  });
});

function simulate(c: CharacterController, status: EmployeeStatus, seconds: number, opts: { ambient?: boolean; start?: number } = {}) {
  const dt = 1 / 30;
  let now = opts.start ?? 0;
  for (let t = 0; t < seconds; t += dt) {
    now += dt;
    c.update(dt, { now, status, ambient: opts.ambient ?? false, requestBreak: () => true, meetingSeat: () => MEETING_SEATS[0] });
  }
  return now;
}

describe("character controller", () => {
  const seat = DESK_SEATS.get("sales-desk-1")!;

  it("starts seated at the desk when idle", () => {
    const c = new CharacterController("e1", 7, seat, "idle");
    expect(c.mode).toBe("seated");
    expect(c.x).toBeCloseTo(seat.x);
    expect(c.doing).toBe("At desk");
  });

  it("walks out through the elevator when suspended, and returns when activated", () => {
    const c = new CharacterController("e1", 7, seat, "idle");
    let now = simulate(c, "suspended", 1);
    expect(["standingUp", "walking"]).toContain(c.mode);
    now = simulate(c, "suspended", 60, { start: now });
    expect(c.mode).toBe("away");
    expect(c.visible).toBe(false);
    now = simulate(c, "idle", 1, { start: now });
    expect(c.visible).toBe(true);
    simulate(c, "idle", 60, { start: now });
    expect(c.mode).toBe("seated");
    expect(c.x).toBeCloseTo(seat.x, 1);
    expect(c.z).toBeCloseTo(seat.z, 1);
  });

  it("goes upstairs to the meeting room via the elevator for meetings", () => {
    const c = new CharacterController("e1", 7, seat, "idle");
    simulate(c, "meeting", 90);
    expect(c.floor).toBe("L2");
    expect(c.mode).toBe("seated");
    expect(c.x).toBeCloseTo(MEETING_SEATS[0].x, 1);
    expect(c.doing).toBe("In the meeting room");
  });

  it("takes only labelled ambient breaks, and only when enabled and idle", () => {
    const off = new CharacterController("e1", 7, seat, "idle");
    simulate(off, "idle", 400);
    expect(off.mode).toBe("seated");

    const on = new CharacterController("e2", 7, seat, "idle");
    const seen = new Set<string>();
    const dt = 1 / 10;
    for (let now = 0; now < 600; now += dt) {
      on.update(dt, { now, status: "idle", ambient: true, requestBreak: () => true, meetingSeat: () => null });
      seen.add(on.doing);
    }
    expect([...seen].some((d) => d.includes("(ambient)"))).toBe(true);

    const busy = new CharacterController("e3", 7, seat, "working");
    simulate(busy, "working", 600, { ambient: true });
    expect(busy.mode).toBe("seated");
  });

  it("is hidden when the employee has no desk in this building", () => {
    const c = new CharacterController("e1", 7, null, "idle");
    expect(c.visible).toBe(false);
    expect(c.doing).toBe("No desk in this building");
  });
});

describe("office world", () => {
  const employee = (id: string, desk: string | null, status: EmployeeStatus = "idle"): Employee => ({
    id,
    name: id,
    role: "Role",
    department: "sales",
    seniority: "mid",
    desk_id: desk,
    avatar_seed: 5,
    status,
    status_detail: null,
    status_changed_at: "2026-10-08T00:00:00Z",
  });

  it("syncs residents with the roster and keeps controllers across status updates", () => {
    const world = new OfficeWorld();
    world.sync([employee("a", "sales-desk-1"), employee("b", "sales-desk-2")]);
    expect(world.residents.size).toBe(2);
    const controller = world.residents.get("a")!.controller;
    world.sync([employee("a", "sales-desk-1", "suspended")]);
    expect(world.residents.size).toBe(1);
    expect(world.residents.get("a")!.controller).toBe(controller);
    expect(world.residents.get("a")!.employee.status).toBe("suspended");
  });

  it("limits simultaneous ambient breaks", () => {
    const world = new OfficeWorld();
    world.sync(
      ["sales-desk-1", "sales-desk-2", "sales-desk-3", "sales-desk-4", "sales-desk-5"].map((d, i) => employee(`e${i}`, d)),
    );
    let maxOnBreak = 0;
    for (let now = 0; now < 900; now += 0.1) {
      world.update(0.1, now, true);
      maxOnBreak = Math.max(maxOnBreak, [...world.residents.values()].filter((r) => r.controller.onBreak).length);
    }
    expect(maxOnBreak).toBeGreaterThan(0);
    expect(maxOnBreak).toBeLessThanOrEqual(2);
  });
});
