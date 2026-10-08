import { ELEVATOR, FLOORS, PLINTH, PLINTH_TOP } from "../layout/building";
import type { FloorId } from "../layout/types";
import { type BuiltParts, PartsBuilder } from "./PartsBuilder";
import { WALL_COLORS } from "./walls";

const SLAB = "#3b4673";
const SLAB_EDGE = "#4b5891";
const PLINTH_COLOR = "#2a3358";
const PLINTH_TOP_COLOR = "#36416c";
const GLOW = "#5ee8f5";

/** Outdoor platform, entrance steps and glowing perimeter. */
export function buildPlinth(): BuiltParts {
  const b = new PartsBuilder();
  const { x0, z0, x1, z1 } = PLINTH;
  const w = x1 - x0;
  const d = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  b.box([w, 0.75, d], { position: [cx, PLINTH_TOP - 0.375, cz], color: PLINTH_COLOR, radius: 0.25 });
  b.box([w - 0.5, 0.02, d - 0.5], { position: [cx, PLINTH_TOP + 0.005, cz], color: PLINTH_TOP_COLOR, radius: 0.01 });
  // Perimeter light strip.
  b.box([w - 0.3, 0.03, 0.04], { position: [cx, PLINTH_TOP - 0.06, z1 + 0.005], color: GLOW, finish: "glow", intensity: 2.4 });
  b.box([w - 0.3, 0.03, 0.04], { position: [cx, PLINTH_TOP - 0.06, z0 - 0.005], color: GLOW, finish: "glow", intensity: 2.4 });
  b.box([0.04, 0.03, d - 0.3], { position: [x0 - 0.005, PLINTH_TOP - 0.06, cz], color: GLOW, finish: "glow", intensity: 2.4 });
  b.box([0.04, 0.03, d - 0.3], { position: [x1 + 0.005, PLINTH_TOP - 0.06, cz], color: GLOW, finish: "glow", intensity: 2.4 });
  // Entrance path and steps up to the ground floor (y = 0).
  b.box([3.4, 0.02, 3.4], { position: [0, PLINTH_TOP + 0.012, 13.6], color: "#46528a", radius: 0.01 });
  const steps = 3;
  for (let i = 0; i < steps; i++) {
    const top = PLINTH_TOP + ((i + 1) * -PLINTH_TOP) / (steps + 1);
    const zFront = 11 + (steps - i) * 0.35;
    b.box([4.6, top - PLINTH_TOP, zFront - 11], { position: [0, (top + PLINTH_TOP) / 2, (zFront + 11) / 2], color: i % 2 ? SLAB_EDGE : SLAB });
    b.box([4.6, 0.012, 0.03], { position: [0, top + 0.006, zFront - 0.02], color: GLOW, finish: "glow", intensity: 1.2 });
  }
  return b.build();
}

/** The structural slab under a floor (ground: on the plinth; upper: floor plate + fascia). */
export function buildSlab(floorId: FloorId): BuiltParts {
  const floor = FLOORS.find((f) => f.id === floorId)!;
  const { x0, z0, x1, z1 } = floor.footprint;
  const b = new PartsBuilder();
  const w = x1 - x0;
  const d = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  if (floor.level === 1) {
    b.box([w + 0.3, -PLINTH_TOP, d + 0.3], { position: [cx, PLINTH_TOP / 2, cz], color: SLAB });
  } else {
    const thickness = 0.25;
    b.box([w + 0.3, thickness, d + 0.3], { position: [cx, floor.elevation - thickness / 2, cz], color: SLAB });
    b.box([w + 0.34, 0.06, 0.06], { position: [cx, floor.elevation - thickness - 0.01, z1 + 0.15], color: SLAB_EDGE });
    b.box([w + 0.3, 0.025, 0.03], { position: [cx, floor.elevation - thickness + 0.03, z1 + 0.17], color: GLOW, finish: "glow", intensity: 2.6 });
  }
  return b.build();
}

/** External glass elevator tower on the east facade (static in Stage 2). */
export function buildElevator(): BuiltParts {
  const { x0, x1, z0, z1, top } = ELEVATOR;
  const b = new PartsBuilder();
  const w = x1 - x0;
  const d = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const bottom = PLINTH_TOP;
  const h = top - bottom;
  b.box([w + 0.3, 0.2, d + 0.3], { position: [cx, bottom + 0.1, cz], color: WALL_COLORS.trim });
  b.box([w + 0.3, 0.3, d + 0.3], { position: [cx, top + 0.15, cz], color: WALL_COLORS.trim, radius: 0.05 });
  for (const x of [x0, x1]) for (const z of [z0, z1]) {
    b.box([0.12, h, 0.12], { position: [x, bottom + h / 2, z], color: WALL_COLORS.trim, finish: "gloss" });
    b.box([0.025, h - 0.4, 0.025], { position: [x + (x === x0 ? 0.07 : -0.07), bottom + h / 2, z + (z === z0 ? 0.07 : -0.07)], color: GLOW, finish: "glow", intensity: 2.6 });
  }
  // Glass skin on the three outer faces; the west face meets the building.
  b.box([0.02, h, d], { position: [x1, bottom + h / 2, cz], color: "#9fe9ff", finish: "glass" });
  b.box([w, h, 0.02], { position: [cx, bottom + h / 2, z0], color: "#9fe9ff", finish: "glass" });
  b.box([w, h, 0.02], { position: [cx, bottom + h / 2, z1], color: "#9fe9ff", finish: "glass" });
  // Landing bridges at each floor and the cab parked at the ground floor.
  for (const f of FLOORS) b.box([0.5, 0.08, 1.8], { position: [16.2, f.elevation - 0.04, cz], color: SLAB_EDGE });
  b.box([w - 0.5, 2.4, d - 0.5], { position: [cx, 1.25, cz], color: "#d8f6ff", finish: "glass" });
  b.box([w - 0.5, 0.1, d - 0.5], { position: [cx, 0.05, cz], color: WALL_COLORS.trim });
  b.box([w - 0.5, 0.1, d - 0.5], { position: [cx, 2.5, cz], color: WALL_COLORS.trim });
  b.box([w - 0.7, 0.02, d - 0.7], { position: [cx, 2.44, cz], color: "#e0fbff", finish: "glow", intensity: 2 });
  // Guide rails.
  for (const z of [z0 + 0.4, z1 - 0.4]) b.box([0.05, h, 0.05], { position: [x1 - 0.12, bottom + h / 2, z], color: "#8792ad", finish: "gloss" });
  return b.build();
}
