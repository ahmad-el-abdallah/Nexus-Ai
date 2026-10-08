import type { FurnitureType, Placement, Rect } from "./types";

/**
 * Approximate floor footprint of each furniture type in local space
 * ([width along x, depth along z], metres). Used for layout validation and
 * the 2D floor plan; the 3D geometry is built to fit inside these.
 */
export const FOOTPRINTS: Record<FurnitureType, [number, number]> = {
  desk: [1.6, 0.8],
  chair: [0.65, 0.65],
  execDesk: [2.4, 1.0],
  execChair: [0.75, 0.75],
  receptionDesk: [4.2, 1.7],
  plant: [0.6, 0.6],
  plantTall: [0.7, 0.7],
  tree: [1.8, 1.8],
  sofa: [2.1, 0.9],
  armchair: [0.95, 0.9],
  coffeeTable: [1.2, 0.65],
  roundTable: [1.0, 1.0],
  cafeTable: [0.8, 0.8],
  cafeChair: [0.5, 0.5],
  stool: [0.45, 0.45],
  collabTable: [2.4, 0.9],
  conferenceTable: [5.0, 1.4],
  bookshelf: [2.0, 0.4],
  serverRack: [0.6, 1.0],
  pingPong: [2.74, 1.7],
  beanbag: [0.9, 0.9],
  counter: [6.0, 0.75],
  fridge: [0.8, 0.7],
  waterCooler: [0.4, 0.4],
  floorLamp: [0.4, 0.4],
  globe: [0.6, 0.6],
  rug: [3.2, 2.4],
  pendant: [0.5, 0.5],
  gate: [2.8, 1.25],
  bollard: [0.25, 0.25],
};

/** Items that don't occupy floor space (rugs lie under things, pendants hang). */
export const NON_BLOCKING: ReadonlySet<FurnitureType> = new Set(["rug", "pendant"]);

export const SEATING_TYPES: ReadonlySet<FurnitureType> = new Set([
  "chair",
  "execChair",
  "cafeChair",
  "stool",
]);
export const TABLE_TYPES: ReadonlySet<FurnitureType> = new Set([
  "desk",
  "execDesk",
  "receptionDesk",
  "conferenceTable",
  "roundTable",
  "cafeTable",
  "collabTable",
]);

/** Axis-aligned bounds of a placement; non-right-angle rotations use the enclosing square. */
export function placementBounds(p: Placement): Rect {
  const [w, d] = FOOTPRINTS[p.type];
  const quarterTurns = p.rot / (Math.PI / 2);
  const isRightAngle = Math.abs(quarterTurns - Math.round(quarterTurns)) < 1e-6;
  let hw: number;
  let hd: number;
  if (isRightAngle) {
    const odd = Math.abs(Math.round(quarterTurns)) % 2 === 1;
    hw = (odd ? d : w) / 2;
    hd = (odd ? w : d) / 2;
  } else {
    hw = hd = Math.max(w, d) / 2;
  }
  return { x0: p.x - hw, z0: p.z - hd, x1: p.x + hw, z1: p.z + hd };
}
