/**
 * Wall geometry. Walls are modelled in a local frame (x along the wall,
 * z across it, y up) and then rotated into place. Walls that can face the
 * camera also get a "cut" version: a low stub with a bright top edge, the
 * classic cutaway look used when the camera looks through them.
 */

import { WALLS } from "../layout/building";
import { FLOOR_BY_ID, wallLength } from "../layout/queries";
import type { FloorId, WallDef } from "../layout/types";
import { type BuiltParts, PartsBuilder } from "./PartsBuilder";

export const WALL_THICKNESS = 0.24;
export const DOOR_HEIGHT = 2.35;
const CUT_HEIGHT = 0.32;

export const WALL_COLORS = {
  body: "#2f3b68",
  inner: "#3a4778",
  top: "#6474b3",
  trim: "#1c2340",
  frame: "#232a45",
  glass: "#a8e8ff",
  cove: "#7dd3fc",
  railGlow: "#5ee8f5",
};
const C = WALL_COLORS;

/** Rotation about y that maps local +x onto the wall direction. */
export function wallRotation(wall: WallDef): number {
  const [ax, az] = wall.from;
  const [bx, bz] = wall.to;
  return Math.atan2(-(bz - az), bx - ax);
}

/** Side (+1 / -1 in local z) that `cutNormal` points to, i.e. the outside. */
export function outsideSign(wall: WallDef): number {
  if (!wall.cutNormal) return 1;
  const [ax, az] = wall.from;
  const [bx, bz] = wall.to;
  const len = Math.hypot(bx - ax, bz - az);
  const dx = (bx - ax) / len;
  const dz = (bz - az) / len;
  // Local +z in world space is (dz, -dx) rotated… derive via the rotation:
  // local z maps to (sin θ, cos θ) with θ = atan2(-dz, dx) → (-dz, dx).
  const lzX = -dz;
  const lzZ = dx;
  return Math.sign(lzX * wall.cutNormal[0] + lzZ * wall.cutNormal[1]) || 1;
}

interface Interval {
  a: number;
  b: number;
}

function freeSegments(length: number, wall: WallDef, margin: number): Interval[] {
  const blocked = (wall.openings ?? [])
    .map((o) => ({ a: o.at - o.width / 2 - margin, b: o.at + o.width / 2 + margin }))
    .sort((p, q) => p.a - q.a);
  const out: Interval[] = [];
  let cursor = 0;
  for (const iv of blocked) {
    if (iv.a > cursor) out.push({ a: cursor, b: iv.a });
    cursor = Math.max(cursor, iv.b);
  }
  if (cursor < length) out.push({ a: cursor, b: length });
  return out;
}

/** Solid wall run from a to b (local x), full or partial height. */
function slab(b: PartsBuilder, a: number, z: number, y0: number, y1: number, color: string, t = WALL_THICKNESS) {
  if (z - a < 0.005 || y1 - y0 < 0.005) return;
  b.box([z - a, y1 - y0, t], { position: [(a + z) / 2, (y0 + y1) / 2, 0], color });
}

function buildOpaque(wall: WallDef, height: number): { full: PartsBuilder; cut?: PartsBuilder } {
  const length = wallLength(wall);
  const full = new PartsBuilder();
  const cut = new PartsBuilder();
  const inside = -outsideSign(wall);
  const openings = wall.openings ?? [];

  // Door openings: header above, dark jamb trims.
  for (const o of openings) {
    const a = o.at - o.width / 2;
    const z = o.at + o.width / 2;
    slab(full, a, z, DOOR_HEIGHT, height, C.body);
    for (const x of [a, z]) full.box([0.05, DOOR_HEIGHT, WALL_THICKNESS + 0.04], { position: [x, DOOR_HEIGHT / 2, 0], color: C.trim });
    full.box([o.width + 0.1, 0.06, WALL_THICKNESS + 0.04], { position: [o.at, DOOR_HEIGHT + 0.03, 0], color: C.trim });
  }

  const sill = 0.85;
  const head = height - 0.7;
  for (const seg of freeSegments(length, wall, 0)) {
    const segLen = seg.b - seg.a;
    slab(cut, seg.a, seg.b, 0, CUT_HEIGHT, C.body);
    cut.box([segLen, 0.03, WALL_THICKNESS + 0.02], { position: [(seg.a + seg.b) / 2, CUT_HEIGHT + 0.015, 0], color: C.top });

    const pier = 0.55;
    const count = wall.windows ? Math.floor((segLen - pier) / (1.9 + pier)) : 0;
    if (count < 1) {
      slab(full, seg.a, seg.b, 0, height, C.body);
      continue;
    }
    const win = Math.min(2.4, (segLen - pier * (count + 1)) / count);
    const spare = segLen - count * win - (count - 1) * pier;
    let x = seg.a;
    slab(full, x, x + spare / 2, 0, height, C.body);
    x += spare / 2;
    for (let i = 0; i < count; i++) {
      const cx = x + win / 2;
      slab(full, x, x + win, 0, sill, C.body);
      slab(full, x, x + win, head, height, C.body);
      full.box([win, head - sill, 0.02], { position: [cx, (sill + head) / 2, 0], color: C.glass, finish: "glass" });
      full.box([win + 0.08, 0.05, WALL_THICKNESS + 0.08], { position: [cx, sill, 0], color: C.frame, finish: "gloss" });
      full.box([win, 0.04, 0.08], { position: [cx, head - 0.02, 0], color: C.frame });
      for (const fx of [x + 0.02, x + win - 0.02, ...(win > 1.3 ? [cx] : [])]) {
        full.box([0.04, head - sill, 0.08], { position: [fx, (sill + head) / 2, 0], color: C.frame });
      }
      x += win;
      if (i < count - 1) {
        slab(full, x, x + pier, 0, height, C.body);
        x += pier;
      }
    }
    slab(full, x, seg.b, 0, height, C.body);
  }

  // Bright top edge (walls are seen from above) and an LED cove on the inside face.
  full.box([length, 0.03, WALL_THICKNESS + 0.02], { position: [length / 2, height + 0.015, 0], color: C.top });
  for (const seg of freeSegments(length, wall, 0.05)) {
    const len = seg.b - seg.a;
    full.box([len, 0.03, 0.03], {
      position: [(seg.a + seg.b) / 2, height - 0.1, inside * (WALL_THICKNESS / 2 + 0.03)],
      color: C.cove,
      finish: "glow",
      intensity: 1.6,
    });
  }
  return { full, cut: wall.cutNormal ? cut : undefined };
}

function buildGlass(wall: WallDef, height: number, storefront: boolean): PartsBuilder {
  const length = wallLength(wall);
  const b = new PartsBuilder();
  const post = storefront ? 0.08 : 0.05;
  const frame = storefront ? C.trim : C.frame;
  for (const seg of freeSegments(length, wall, 0)) {
    const segLen = seg.b - seg.a;
    const bays = Math.max(1, Math.round(segLen / (storefront ? 2.0 : 1.5)));
    const bay = segLen / bays;
    for (let i = 0; i <= bays; i++) {
      b.box([post, height, post + 0.02], { position: [seg.a + i * bay, height / 2, 0], color: frame, finish: "gloss" });
    }
    b.box([segLen, height - 0.12, 0.014], { position: [(seg.a + seg.b) / 2, (height - 0.12) / 2 + 0.06, 0], color: C.glass, finish: "glass" });
    b.box([segLen, 0.06, 0.08], { position: [(seg.a + seg.b) / 2, 0.03, 0], color: frame });
    if (storefront) b.box([segLen, 0.05, 0.1], { position: [(seg.a + seg.b) / 2, DOOR_HEIGHT + 0.05, 0], color: frame });
  }
  for (const o of wall.openings ?? []) {
    const a = o.at - o.width / 2;
    const z = o.at + o.width / 2;
    for (const x of [a, z]) b.box([post, height, post + 0.02], { position: [x, height / 2, 0], color: frame, finish: "gloss" });
    b.box([o.width, 0.08, 0.09], { position: [o.at, DOOR_HEIGHT + 0.04, 0], color: frame, finish: "gloss" });
    b.box([o.width, height - DOOR_HEIGHT - 0.1, 0.014], { position: [o.at, (DOOR_HEIGHT + 0.08 + height) / 2, 0], color: C.glass, finish: "glass" });
  }
  b.box([length, 0.05, 0.09], { position: [length / 2, height - 0.025, 0], color: frame, finish: "gloss" });
  return b;
}

function buildRailing(wall: WallDef): PartsBuilder {
  const length = wallLength(wall);
  const b = new PartsBuilder();
  const h = 1.05;
  const posts = Math.round(length / 2);
  for (let i = 0; i <= posts; i++) b.box([0.05, h, 0.05], { position: [(i * length) / posts, h / 2, 0], color: C.frame, finish: "gloss" });
  b.box([length, h - 0.12, 0.016], { position: [length / 2, (h - 0.12) / 2 + 0.06, 0], color: C.glass, finish: "glass" });
  b.box([length, 0.05, 0.09], { position: [length / 2, h, 0], color: "#9aa6c6", finish: "gloss", radius: 0.02 });
  b.box([length, 0.02, 0.02], { position: [length / 2, h - 0.05, 0.05], color: C.railGlow, finish: "glow", intensity: 2.2 });
  b.box([length, 0.06, 0.08], { position: [length / 2, 0.03, 0], color: C.frame });
  return b;
}

export interface WallGroupGeometry {
  key: string;
  floor: FloorId;
  /** null for walls that never cut away (glass, railings, storefront). */
  cutNormal: [number, number] | null;
  wallIds: string[];
  full: BuiltParts;
  cut: BuiltParts | null;
}

/**
 * Builds wall geometry grouped by floor and cut direction so that walls
 * which hide together render together.
 */
export function buildWallGroups(): WallGroupGeometry[] {
  const groups = new Map<string, { floor: FloorId; cutNormal: [number, number] | null; ids: string[]; full: PartsBuilder; cut: PartsBuilder }>();
  for (const wall of WALLS) {
    const floor = FLOOR_BY_ID.get(wall.floor)!;
    const key = `${wall.floor}:${wall.cutNormal ? wall.cutNormal.join(",") : "static"}`;
    let group = groups.get(key);
    if (!group) {
      group = { floor: wall.floor, cutNormal: wall.cutNormal ?? null, ids: [], full: new PartsBuilder(), cut: new PartsBuilder() };
      groups.set(key, group);
    }
    group.ids.push(wall.id);
    const origin: [number, number, number] = [wall.from[0], floor.elevation, wall.from[1]];
    const rotation = wallRotation(wall);
    if (wall.kind === "exterior" || wall.kind === "solid") {
      const { full, cut } = buildOpaque(wall, floor.height);
      group.full.merge(full, origin, rotation);
      if (cut) group.cut.merge(cut, origin, rotation);
    } else if (wall.kind === "railing") {
      group.full.merge(buildRailing(wall), origin, rotation);
    } else {
      group.full.merge(buildGlass(wall, floor.height, wall.kind === "storefront"), origin, rotation);
    }
  }
  return [...groups.entries()].map(([key, g]) => ({
    key,
    floor: g.floor,
    cutNormal: g.cutNormal,
    wallIds: g.ids,
    full: g.full.build(),
    cut: g.cut.isEmpty ? null : g.cut.build(),
  }));
}

/** Which wall group a wall belongs to (wall items and doors hide with it). */
export function wallGroupKey(wallId: string): string {
  const wall = WALLS.find((w) => w.id === wallId);
  if (!wall) throw new Error(`Unknown wall ${wallId}`);
  return `${wall.floor}:${wall.cutNormal ? wall.cutNormal.join(",") : "static"}`;
}
