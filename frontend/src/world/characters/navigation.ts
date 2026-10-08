/**
 * Walkability grids and A* path finding for employees moving around the
 * building. Grids are rasterised from the same layout data as the 3D scene:
 * walls block (except openings), furniture blocks (except seats, which
 * people walk up to), and the elevator interior is walkable on every floor.
 */

import { ELEVATOR, FLOORS, PLACEMENTS, WALLS } from "../layout/building";
import { NON_BLOCKING, placementBounds, SEATING_TYPES } from "../layout/footprints";
import { pointOnWall, wallLength } from "../layout/queries";
import type { FloorId, Rect } from "../layout/types";

export const CELL = 0.25;
const BOUNDS: Rect = { x0: -16.5, z0: -11.5, x1: 19.5, z1: 11.5 };
const COLS = Math.round((BOUNDS.x1 - BOUNDS.x0) / CELL);
const ROWS = Math.round((BOUNDS.z1 - BOUNDS.z0) / CELL);
/** Clearance kept from obstacles (body radius). */
const INFLATE = 0.2;

export interface Point {
  x: number;
  z: number;
}

/** Where people stand inside the elevator on any floor. */
export const ELEVATOR_SPOT: Point = { x: (ELEVATOR.x0 + ELEVATOR.x1) / 2, z: (ELEVATOR.z0 + ELEVATOR.z1) / 2 };

export class NavGrid {
  readonly blocked: Uint8Array;

  constructor(readonly floor: FloorId) {
    this.blocked = new Uint8Array(COLS * ROWS).fill(1);
    const def = FLOORS.find((f) => f.id === floor)!;
    this.fill(def.footprint, 0);
    this.fill({ x0: ELEVATOR.x0 + 0.15, z0: ELEVATOR.z0 + 0.15, x1: ELEVATOR.x1 - 0.15, z1: ELEVATOR.z1 - 0.15 }, 0);
    // Keep a margin along the outer walls.
    const { x0, z0, x1, z1 } = def.footprint;
    for (const r of [
      { x0, z0, x1, z1: z0 + 0.3 },
      { x0, z0: z1 - 0.3, x1, z1 },
      { x0, z0, x1: x0 + 0.3, z1 },
      { x0: x1 - 0.3, z0, x1, z1 },
    ])
      this.fill(r, 1);
    for (const wall of WALLS.filter((w) => w.floor === floor)) this.rasteriseWall(wall);
    for (const p of PLACEMENTS) {
      if (p.floor !== floor || NON_BLOCKING.has(p.type) || SEATING_TYPES.has(p.type)) continue;
      const b = placementBounds(p);
      this.fill({ x0: b.x0 - INFLATE, z0: b.z0 - INFLATE, x1: b.x1 + INFLATE, z1: b.z1 + INFLATE }, 1);
    }
  }

  private fill(r: Rect, value: 0 | 1) {
    const c0 = Math.max(0, Math.floor((r.x0 - BOUNDS.x0) / CELL));
    const c1 = Math.min(COLS - 1, Math.ceil((r.x1 - BOUNDS.x0) / CELL) - 1);
    const r0 = Math.max(0, Math.floor((r.z0 - BOUNDS.z0) / CELL));
    const r1 = Math.min(ROWS - 1, Math.ceil((r.z1 - BOUNDS.z0) / CELL) - 1);
    for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) this.blocked[row * COLS + col] = value;
  }

  private rasteriseWall(wall: (typeof WALLS)[number]) {
    const length = wallLength(wall);
    const t = 0.15 + INFLATE;
    const openings = (wall.openings ?? []).map((o) => [o.at - o.width / 2 + 0.1, o.at + o.width / 2 - 0.1] as const);
    for (let s = 0; s < length; s += CELL / 2) {
      if (openings.some(([a, b]) => s > a && s < b)) continue;
      const p = pointOnWall(wall, s);
      this.fill({ x0: p.x - t, z0: p.z - t, x1: p.x + t, z1: p.z + t }, 1);
    }
    // Re-open door gaps that neighbouring wall samples may have inflated over.
    for (const o of wall.openings ?? []) {
      const p = pointOnWall(wall, o.at);
      const half = o.width / 2 - 0.25;
      const alongX = Math.abs(p.dx) > 0.5;
      this.fill(
        alongX
          ? { x0: p.x - half, x1: p.x + half, z0: p.z - 0.6, z1: p.z + 0.6 }
          : { x0: p.x - 0.6, x1: p.x + 0.6, z0: p.z - half, z1: p.z + half },
        0,
      );
    }
  }

  cellOf(p: Point): [number, number] {
    return [Math.floor((p.x - BOUNDS.x0) / CELL), Math.floor((p.z - BOUNDS.z0) / CELL)];
  }

  centerOf(col: number, row: number): Point {
    return { x: BOUNDS.x0 + (col + 0.5) * CELL, z: BOUNDS.z0 + (row + 0.5) * CELL };
  }

  isWalkable(col: number, row: number): boolean {
    return col >= 0 && row >= 0 && col < COLS && row < ROWS && this.blocked[row * COLS + col] === 0;
  }

  isPointWalkable(p: Point): boolean {
    const [c, r] = this.cellOf(p);
    return this.isWalkable(c, r);
  }

  /** Nearest walkable cell to a point (spiral search). */
  nearestWalkable(p: Point): [number, number] | null {
    const [c, r] = this.cellOf(p);
    for (let radius = 0; radius < 12; radius++) {
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius || !this.isWalkable(c + dc, r + dr)) continue;
          const q = this.centerOf(c + dc, r + dr);
          const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = [c + dc, r + dr];
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** Straight walk between two points stays on walkable cells. */
  lineOfSight(a: Point, b: Point): boolean {
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(dist / (CELL / 3)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const [c, r] = this.cellOf({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      if (!this.isWalkable(c, r)) return false;
    }
    return true;
  }

  /**
   * A* on the grid (8-connected, no corner cutting), then string-pulled into
   * a short list of waypoints. Start/goal snap to the nearest walkable cell;
   * the exact goal point is appended so people end where they intend to.
   */
  findPath(from: Point, to: Point): Point[] | null {
    const start = this.nearestWalkable(from);
    const goal = this.nearestWalkable(to);
    if (!start || !goal) return null;
    const startIdx = start[1] * COLS + start[0];
    const goalIdx = goal[1] * COLS + goal[0];
    const g = new Float32Array(COLS * ROWS).fill(Infinity);
    const came = new Int32Array(COLS * ROWS).fill(-1);
    const closed = new Uint8Array(COLS * ROWS);
    const open = new MinHeap();
    const h = (idx: number) => {
      const dc = Math.abs((idx % COLS) - goal[0]);
      const dr = Math.abs(Math.floor(idx / COLS) - goal[1]);
      return Math.max(dc, dr) + (Math.SQRT2 - 1) * Math.min(dc, dr);
    };
    g[startIdx] = 0;
    open.push(startIdx, h(startIdx));
    while (open.size > 0) {
      const current = open.pop();
      if (current === goalIdx) break;
      if (closed[current]) continue;
      closed[current] = 1;
      const cc = current % COLS;
      const cr = Math.floor(current / COLS);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dc && !dr) continue;
          const nc = cc + dc;
          const nr = cr + dr;
          if (!this.isWalkable(nc, nr)) continue;
          if (dc && dr && (!this.isWalkable(cc + dc, cr) || !this.isWalkable(cc, cr + dr))) continue;
          const n = nr * COLS + nc;
          const cost = g[current] + (dc && dr ? Math.SQRT2 : 1);
          if (cost < g[n]) {
            g[n] = cost;
            came[n] = current;
            open.push(n, cost + h(n));
          }
        }
      }
    }
    if (startIdx !== goalIdx && came[goalIdx] === -1) return null;
    const cells: Point[] = [];
    for (let i = goalIdx; i !== -1; i = came[i]) {
      cells.push(this.centerOf(i % COLS, Math.floor(i / COLS)));
      if (i === startIdx) break;
    }
    cells.reverse();
    // String pulling: keep only the waypoints needed to stay on walkable cells.
    const path: Point[] = [from];
    let anchor = from;
    for (let i = 1; i < cells.length; i++) {
      if (!this.lineOfSight(anchor, cells[i])) {
        anchor = cells[i - 1];
        path.push(anchor);
      }
    }
    path.push(to);
    return path;
  }
}

class MinHeap {
  private items: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.items.length;
  }
  push(item: number, key: number) {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.items.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}

const grids = new Map<FloorId, NavGrid>();
export function navGrid(floor: FloorId): NavGrid {
  let grid = grids.get(floor);
  if (!grid) {
    grid = new NavGrid(floor);
    grids.set(floor, grid);
  }
  return grid;
}

/** Decorative break spots (ambient life only). Facing is the direction people look. */
export const AMBIENT_SPOTS: Record<FloorId, Array<Point & { yaw: number; label: string }>> = {
  L1: [
    { x: 6.2, z: -9.25, yaw: Math.PI, label: "café counter" },
    { x: 7.6, z: -9.25, yaw: Math.PI, label: "café counter" },
    { x: 15.0, z: -9.7, yaw: Math.PI, label: "water cooler" },
    { x: -6.6, z: -3.65, yaw: Math.PI, label: "ping-pong table" },
    { x: -9.3, z: -9.75, yaw: Math.PI, label: "bookshelf" },
  ],
  L2: [
    { x: 6.4, z: -0.25, yaw: Math.PI, label: "standing table" },
    { x: 13.0, z: -9.25, yaw: Math.PI, label: "server racks" },
    { x: -14.9, z: -5.0, yaw: -Math.PI / 2, label: "window" },
  ],
};
