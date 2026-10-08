/**
 * Procedural furniture catalogue. Every piece is modelled from rounded
 * primitives in local space: origin at floor level, centred, front = +z.
 * Pieces stay within the footprints declared in layout/footprints.ts.
 */

import { Shape } from "three";

import type { FurnitureType } from "../layout/types";
import { type BuiltParts, PartsBuilder } from "./PartsBuilder";

export const PALETTE = {
  wood: "#c8986a",
  woodMid: "#a0714b",
  woodDark: "#5f3f2a",
  white: "#e9edf5",
  offWhite: "#cfd6e4",
  graphite: "#272c3f",
  charcoal: "#1b1e2b",
  black: "#101219",
  metal: "#aab3c6",
  steel: "#6f7a91",
  fabric: "#e6e9f1",
  leather: "#2a2532",
  panel: "#38446f",
  pot: "#ebe6de",
  potDark: "#363e56",
  soil: "#4a3426",
  concrete: "#8d96aa",
  leaf: ["#3f9d5a", "#2f7d4a", "#5cb36d", "#468a3d", "#2a6b43"],
  cyan: "#5ee8f5",
  warm: "#ffd7a1",
} as const;

const P = PALETTE;

/** Deterministic PRNG so generated details are identical on every load. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function desk(): PartsBuilder {
  const b = new PartsBuilder();
  b.box([1.6, 0.045, 0.8], { position: [0, 0.735, 0], color: P.wood, radius: 0.015 });
  for (const s of [-1, 1]) b.box([0.05, 0.71, 0.72], { position: [s * 0.76, 0.355, 0], color: P.white, radius: 0.012 });
  // Privacy divider along the back edge (doubles as the pod divider).
  b.box([1.56, 0.34, 0.03], { position: [0, 0.93, -0.385], color: P.panel, radius: 0.012 });
  // Drawer pedestal.
  b.box([0.42, 0.56, 0.6], { position: [0.52, 0.29, -0.06], color: P.offWhite, radius: 0.02 });
  for (const y of [0.42, 0.24]) b.box([0.2, 0.014, 0.014], { position: [0.52, y, 0.245], color: P.steel, finish: "gloss" });
  // Keyboard, mouse, notebook, mug.
  b.box([0.44, 0.018, 0.14], { position: [-0.06, 0.766, 0.16], color: P.graphite, radius: 0.006, finish: "gloss" });
  b.box([0.06, 0.022, 0.1], { position: [0.3, 0.767, 0.18], color: P.graphite, radius: 0.01, finish: "gloss" });
  b.box([0.2, 0.012, 0.27], { position: [-0.55, 0.764, 0.08], rotation: [0, 0.25, 0], color: "#5b6b9a" });
  b.cylinder(0.04, 0.035, 0.09, { position: [0.62, 0.803, 0.12], color: P.white, finish: "gloss" });
  return b;
}

/** Monitor housing; the screen surface is a separate textured instance. */
export function monitorFrame(): PartsBuilder {
  const b = new PartsBuilder();
  b.box([0.24, 0.016, 0.16], { position: [0, 0.766, -0.02], color: P.charcoal, radius: 0.006, finish: "gloss" });
  b.box([0.04, 0.28, 0.025], { position: [0, 0.9, -0.05], color: P.charcoal });
  b.box([0.62, 0.38, 0.035], { position: [0, 1.06, -0.03], color: P.black, radius: 0.012, finish: "gloss" });
  return b;
}
/** Screen plane offset relative to the monitor origin (faces +z). */
export const MONITOR_SCREEN = { width: 0.58, height: 0.335, y: 1.06, z: -0.0115 };

function chair(): PartsBuilder {
  const b = new PartsBuilder();
  for (let i = 0; i < 5; i++) {
    const a = (i * Math.PI * 2) / 5;
    b.box([0.045, 0.035, 0.3], { position: [Math.sin(a) * 0.14, 0.075, Math.cos(a) * 0.14], rotation: [0, a, 0], color: P.graphite, radius: 0.012 });
    b.sphere(0.032, { position: [Math.sin(a) * 0.28, 0.032, Math.cos(a) * 0.28], color: P.black, segments: 8 });
  }
  b.cylinder(0.026, 0.026, 0.33, { position: [0, 0.26, 0], color: P.metal, finish: "gloss", segments: 10 });
  b.box([0.5, 0.085, 0.48], { position: [0, 0.465, 0.02], color: P.fabric, radius: 0.035 });
  b.box([0.46, 0.56, 0.075], { position: [0, 0.84, -0.22], rotation: [-0.1, 0, 0], color: P.fabric, radius: 0.035 });
  b.box([0.05, 0.28, 0.03], { position: [0, 0.6, -0.24], color: P.graphite });
  for (const s of [-1, 1]) {
    b.box([0.035, 0.2, 0.035], { position: [s * 0.265, 0.57, 0.0], color: P.graphite });
    b.box([0.06, 0.03, 0.26], { position: [s * 0.265, 0.675, 0.02], color: P.graphite, radius: 0.012 });
  }
  return b;
}

function execChair(): PartsBuilder {
  const b = new PartsBuilder();
  for (let i = 0; i < 5; i++) {
    const a = (i * Math.PI * 2) / 5;
    b.box([0.05, 0.04, 0.34], { position: [Math.sin(a) * 0.16, 0.08, Math.cos(a) * 0.16], rotation: [0, a, 0], color: P.metal, radius: 0.014, finish: "gloss" });
    b.sphere(0.034, { position: [Math.sin(a) * 0.32, 0.034, Math.cos(a) * 0.32], color: P.black, segments: 8 });
  }
  b.cylinder(0.03, 0.03, 0.33, { position: [0, 0.27, 0], color: P.metal, finish: "gloss", segments: 10 });
  b.box([0.58, 0.12, 0.54], { position: [0, 0.49, 0.02], color: P.leather, radius: 0.05, finish: "gloss" });
  b.box([0.56, 0.78, 0.11], { position: [0, 0.98, -0.25], rotation: [-0.12, 0, 0], color: P.leather, radius: 0.05, finish: "gloss" });
  b.box([0.36, 0.16, 0.09], { position: [0, 1.42, -0.31], rotation: [-0.12, 0, 0], color: P.leather, radius: 0.04, finish: "gloss" });
  // Fabric accent stripe picks up the room tint.
  b.box([0.5, 0.5, 0.01], { position: [0, 0.98, -0.19], rotation: [-0.12, 0, 0], color: P.fabric, radius: 0.004 });
  for (const s of [-1, 1]) b.box([0.07, 0.05, 0.36], { position: [s * 0.31, 0.7, 0.02], color: P.leather, radius: 0.02, finish: "gloss" });
  return b;
}

function execDesk(): PartsBuilder {
  const b = new PartsBuilder();
  b.box([2.4, 0.06, 1.0], { position: [0, 0.75, 0], color: P.woodDark, radius: 0.02, finish: "gloss" });
  for (const s of [-1, 1]) b.box([0.08, 0.72, 0.96], { position: [s * 1.14, 0.36, 0], color: P.woodDark, radius: 0.02 });
  b.box([2.2, 0.5, 0.04], { position: [0, 0.45, -0.44], color: P.woodMid, radius: 0.015 });
  // Brass trim along the front edge.
  b.box([2.38, 0.015, 0.02], { position: [0, 0.725, 0.495], color: "#d6b46a", finish: "gloss" });
  // Closed laptop, desk lamp, document tray.
  b.box([0.34, 0.02, 0.24], { position: [-0.55, 0.79, 0.12], color: P.metal, radius: 0.008, finish: "gloss" });
  b.cylinder(0.07, 0.08, 0.02, { position: [0.95, 0.79, -0.25], color: P.charcoal });
  b.cylinder(0.01, 0.01, 0.38, { position: [0.95, 0.98, -0.25], color: P.metal, finish: "gloss" });
  b.cylinder(0.05, 0.1, 0.1, { position: [0.95, 1.18, -0.2], rotation: [0.5, 0, 0], color: P.charcoal });
  b.cylinder(0.045, 0.045, 0.01, { position: [0.95, 1.135, -0.17], rotation: [0.5, 0, 0], color: P.warm, finish: "glow", intensity: 2.4 });
  b.box([0.32, 0.05, 0.24], { position: [0.55, 0.805, 0.1], color: P.charcoal, radius: 0.01 });
  return b;
}

function receptionDesk(): PartsBuilder {
  const b = new PartsBuilder();
  // Arc band between two radii; the convex front faces visitors (+z).
  const band = (r0: number, r1: number, a: number, cz: number) => {
    const shape = new Shape();
    const steps = 28;
    for (let i = 0; i <= steps; i++) {
      const t = -a + (2 * a * i) / steps;
      const x = Math.sin(t) * r1;
      const z = cz + Math.cos(t) * r1;
      if (i === 0) shape.moveTo(x, -z);
      else shape.lineTo(x, -z);
    }
    for (let i = steps; i >= 0; i--) {
      const t = -a + (2 * a * i) / steps;
      shape.lineTo(Math.sin(t) * r0, -(cz + Math.cos(t) * r0));
    }
    return shape;
  };
  const cz = -1.75;
  const a = 0.9;
  const front = new PartsBuilder()
    .extrude(band(2.0, 2.45, a, cz), 1.02, { color: P.white })
    .extrude(band(1.95, 2.55, a, cz), 0.05, { position: [0, 1.02, 0], color: P.wood, finish: "gloss" })
    .extrude(band(1.45, 2.0, a, cz), 0.04, { position: [0, 0.72, 0], color: P.offWhite })
    .extrude(band(2.455, 2.475, a * 0.96, cz), 0.035, { position: [0, 0.12, 0], color: P.cyan, finish: "glow", intensity: 2.6 })
    .extrude(band(2.455, 2.475, a * 0.6, cz), 0.035, { position: [0, 0.82, 0], color: P.cyan, finish: "glow", intensity: 1.8 });
  b.merge(front);
  return b;
}

function plant(seed: number, tall: boolean): PartsBuilder {
  const b = new PartsBuilder();
  const r = rng(seed);
  if (tall) {
    b.cylinder(0.24, 0.19, 0.56, { position: [0, 0.28, 0], color: P.potDark, segments: 18 });
    b.cylinder(0.215, 0.215, 0.02, { position: [0, 0.55, 0], color: P.soil, segments: 18 });
    b.cylinder(0.022, 0.03, 0.9, { position: [0, 1.0, 0], color: P.woodDark, segments: 6 });
    for (let i = 0; i < 6; i++) {
      const a = r() * Math.PI * 2;
      const y = 0.95 + i * 0.13;
      const d = 0.08 + r() * 0.14;
      b.blob(0.13 + r() * 0.08, { position: [Math.cos(a) * d, y, Math.sin(a) * d], scale: [1.3, 0.75, 1], rotation: [0, a, 0.3], color: P.leaf[i % P.leaf.length] });
    }
  } else {
    b.cylinder(0.22, 0.16, 0.42, { position: [0, 0.21, 0], color: P.pot, segments: 18, finish: "gloss" });
    b.cylinder(0.2, 0.2, 0.02, { position: [0, 0.41, 0], color: P.soil, segments: 18 });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + r();
      const d = i === 0 ? 0 : 0.12;
      b.blob(0.16 + r() * 0.06, { position: [Math.cos(a) * d, 0.56 + r() * 0.16, Math.sin(a) * d], color: P.leaf[i % P.leaf.length] });
    }
  }
  return b;
}

function tree(): PartsBuilder {
  const b = new PartsBuilder();
  const r = rng(7);
  b.box([1.3, 0.6, 1.3], { position: [0, 0.3, 0], color: P.concrete, radius: 0.06 });
  b.box([1.18, 0.04, 1.18], { position: [0, 0.6, 0], color: P.soil });
  b.cylinder(0.07, 0.11, 1.5, { position: [0, 1.35, 0], color: P.woodDark, segments: 8 });
  const blobs: [number, number, number, number][] = [
    [0, 2.45, 0, 0.72],
    [0.38, 2.2, 0.15, 0.5],
    [-0.32, 2.25, -0.2, 0.52],
    [0.1, 2.85, -0.12, 0.48],
    [-0.15, 2.05, 0.35, 0.42],
  ];
  blobs.forEach(([x, y, z, s], i) => b.blob(s * (0.9 + r() * 0.2), { position: [x, y, z], color: P.leaf[i % P.leaf.length] }));
  return b;
}

function sofa(): PartsBuilder {
  const b = new PartsBuilder();
  b.box([2.05, 0.3, 0.86], { position: [0, 0.24, 0], color: P.fabric, radius: 0.06 });
  for (const s of [-1, 1]) b.box([0.92, 0.16, 0.66], { position: [s * 0.47, 0.46, 0.07], color: P.fabric, radius: 0.06 });
  b.box([1.9, 0.5, 0.22], { position: [0, 0.62, -0.31], color: P.fabric, radius: 0.08 });
  for (const s of [-1, 1]) b.box([0.18, 0.5, 0.86], { position: [s * 0.95, 0.4, 0], color: P.fabric, radius: 0.07 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.cylinder(0.025, 0.02, 0.09, { position: [sx * 0.92, 0.045, sz * 0.36], color: P.woodDark, segments: 8 });
  // Throw cushions.
  b.box([0.38, 0.34, 0.1], { position: [-0.62, 0.66, -0.15], rotation: [-0.2, 0.15, 0.1], color: P.offWhite, radius: 0.05 });
  b.box([0.38, 0.34, 0.1], { position: [0.62, 0.66, -0.15], rotation: [-0.2, -0.15, -0.1], color: P.offWhite, radius: 0.05 });
  return b;
}

function armchair(): PartsBuilder {
  const b = new PartsBuilder();
  b.box([0.9, 0.3, 0.84], { position: [0, 0.24, 0], color: P.fabric, radius: 0.07 });
  b.box([0.62, 0.15, 0.62], { position: [0, 0.46, 0.08], color: P.fabric, radius: 0.06 });
  b.box([0.86, 0.48, 0.2], { position: [0, 0.6, -0.31], color: P.fabric, radius: 0.08 });
  for (const s of [-1, 1]) b.box([0.16, 0.44, 0.84], { position: [s * 0.37, 0.4, 0], color: P.fabric, radius: 0.07 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.cylinder(0.022, 0.018, 0.09, { position: [sx * 0.36, 0.045, sz * 0.34], color: P.woodDark, segments: 8 });
  return b;
}

function coffeeTable(): PartsBuilder {
  const b = new PartsBuilder();
  b.box([1.15, 0.05, 0.6], { position: [0, 0.4, 0], color: P.wood, radius: 0.02, finish: "gloss" });
  b.box([1.0, 0.03, 0.48], { position: [0, 0.14, 0], color: P.woodMid, radius: 0.01 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.cylinder(0.018, 0.018, 0.38, { position: [sx * 0.52, 0.19, sz * 0.25], color: P.charcoal, segments: 8 });
  b.box([0.22, 0.03, 0.16], { position: [0.25, 0.44, 0.05], rotation: [0, 0.3, 0], color: "#7c5cff" });
  b.cylinder(0.06, 0.05, 0.12, { position: [-0.3, 0.485, -0.05], color: P.white, finish: "gloss" });
  return b;
}

function roundTable(radius: number, height = 0.74): PartsBuilder {
  const b = new PartsBuilder();
  b.cylinder(radius, radius, 0.04, { position: [0, height, 0], color: P.white, segments: 28, finish: "gloss" });
  b.cylinder(0.035, 0.035, height - 0.04, { position: [0, height / 2, 0], color: P.charcoal, segments: 10 });
  b.cylinder(radius * 0.55, radius * 0.6, 0.03, { position: [0, 0.015, 0], color: P.charcoal, segments: 20 });
  return b;
}

function cafeChair(): PartsBuilder {
  const b = new PartsBuilder();
  b.box([0.42, 0.04, 0.42], { position: [0, 0.46, 0.02], color: P.wood, radius: 0.015 });
  b.box([0.42, 0.3, 0.03], { position: [0, 0.72, -0.18], rotation: [-0.08, 0, 0], color: P.wood, radius: 0.012 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.cylinder(0.014, 0.012, 0.45, { position: [sx * 0.18, 0.225, sz * 0.17 + 0.02], color: P.charcoal, segments: 6 });
  for (const s of [-1, 1]) b.cylinder(0.012, 0.012, 0.3, { position: [s * 0.18, 0.6, -0.18], color: P.charcoal, segments: 6 });
  return b;
}

function stool(): PartsBuilder {
  const b = new PartsBuilder();
  b.cylinder(0.18, 0.17, 0.05, { position: [0, 0.72, 0], color: P.fabric, segments: 18 });
  b.cylinder(0.025, 0.025, 0.7, { position: [0, 0.36, 0], color: P.metal, finish: "gloss", segments: 8 });
  b.torus(0.14, 0.012, { position: [0, 0.3, 0], rotation: [Math.PI / 2, 0, 0], color: P.metal, finish: "gloss" });
  b.cylinder(0.17, 0.19, 0.025, { position: [0, 0.0125, 0], color: P.charcoal, segments: 18 });
  return b;
}

function collabTable(): PartsBuilder {
  const b = new PartsBuilder();
  b.box([2.4, 0.05, 0.9], { position: [0, 1.0, 0], color: P.wood, radius: 0.02, finish: "gloss" });
  for (const s of [-1, 1]) b.box([0.08, 0.98, 0.7], { position: [s * 1.0, 0.49, 0], color: P.charcoal, radius: 0.02 });
  b.box([2.0, 0.05, 0.08], { position: [0, 0.25, 0], color: P.charcoal });
  return b;
}

function conferenceTable(): PartsBuilder {
  const b = new PartsBuilder();
  b.box([5.0, 0.06, 1.4], { position: [0, 0.74, 0], color: P.woodDark, radius: 0.03, finish: "gloss" });
  for (const s of [-1, 1]) b.box([0.5, 0.71, 0.8], { position: [s * 1.6, 0.355, 0], color: P.charcoal, radius: 0.03 });
  b.box([3.6, 0.008, 0.05], { position: [0, 0.774, 0], color: P.cyan, finish: "glow", intensity: 1.6 });
  for (const s of [-1, 1]) b.box([0.32, 0.03, 0.14], { position: [s * 0.9, 0.785, 0], color: P.graphite, radius: 0.01, finish: "gloss" });
  return b;
}

function bookshelf(): PartsBuilder {
  const b = new PartsBuilder();
  const r = rng(42);
  const colors = ["#c2410c", "#1d4ed8", "#0f766e", "#a16207", "#6d28d9", "#be123c", "#e2e8f0", "#334155"];
  b.box([2.0, 2.0, 0.04], { position: [0, 1.0, -0.18], color: P.woodMid });
  for (const s of [-1, 1]) b.box([0.04, 2.0, 0.4], { position: [s * 0.98, 1.0, 0], color: P.wood });
  const shelves = [0.02, 0.5, 0.98, 1.46, 1.98];
  for (const y of shelves) b.box([1.96, 0.035, 0.38], { position: [0, y, 0], color: P.wood });
  for (let s = 0; s < shelves.length - 1; s++) {
    let x = -0.92;
    while (x < 0.88) {
      const w = 0.035 + r() * 0.05;
      const h = 0.24 + r() * 0.16;
      if (r() < 0.12) {
        x += 0.12;
        continue;
      }
      b.box([w, h, 0.26], { position: [x + w / 2, shelves[s] + 0.0175 + h / 2, 0.02], color: colors[Math.floor(r() * colors.length)] });
      x += w + 0.006;
    }
  }
  return b;
}

function serverRack(): PartsBuilder {
  const b = new PartsBuilder();
  b.box([0.6, 2.0, 1.0], { position: [0, 1.0, 0], color: P.charcoal, radius: 0.02, finish: "gloss" });
  b.box([0.52, 1.84, 0.02], { position: [0, 1.0, 0.5], color: "#232838" });
  for (let i = 0; i < 18; i++) {
    const y = 0.2 + i * 0.095;
    b.box([0.46, 0.06, 0.012], { position: [0, y, 0.512], color: "#2d3348" });
    b.box([0.02, 0.014, 0.006], { position: [-0.19, y, 0.52], color: i % 3 === 0 ? "#22d3ee" : "#4ade80", finish: "glow", intensity: 2.5 });
    if (i % 2 === 0) b.box([0.02, 0.014, 0.006], { position: [-0.15, y, 0.52], color: "#4ade80", finish: "glow", intensity: 2.2 });
  }
  b.box([0.6, 0.02, 0.02], { position: [0, 1.99, 0.5], color: P.cyan, finish: "glow", intensity: 1.6 });
  return b;
}

function pingPong(): PartsBuilder {
  const b = new PartsBuilder();
  b.box([2.74, 0.04, 1.525], { position: [0, 0.74, 0], color: "#1d4f91", radius: 0.01 });
  b.box([2.74, 0.006, 0.02], { position: [0, 0.762, 0], color: P.white });
  b.box([0.02, 0.15, 1.65], { position: [0, 0.83, 0], color: "#e5e7eb" });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box([0.06, 0.72, 0.06], { position: [sx * 1.2, 0.36, sz * 0.62], color: P.charcoal });
  return b;
}

function beanbag(): PartsBuilder {
  const b = new PartsBuilder();
  b.blob(0.44, { position: [0, 0.27, 0], scale: [1, 0.62, 1], color: P.fabric, detail: 2 });
  b.blob(0.26, { position: [0, 0.48, -0.16], scale: [1.2, 0.8, 0.8], color: P.fabric, detail: 1 });
  return b;
}

function counter(): PartsBuilder {
  const b = new PartsBuilder();
  b.box([5.9, 0.9, 0.7], { position: [0, 0.45, 0], color: P.white, radius: 0.02 });
  b.box([6.0, 0.05, 0.75], { position: [0, 0.925, 0], color: "#3a4157", radius: 0.012, finish: "gloss" });
  b.box([5.8, 0.03, 0.02], { position: [0, 0.1, 0.355], color: P.warm, finish: "glow", intensity: 2 });
  // Espresso machine, grinder, cups, pastry case.
  b.box([0.55, 0.42, 0.42], { position: [-1.6, 1.16, -0.08], color: P.metal, radius: 0.03, finish: "gloss" });
  b.box([0.3, 0.02, 0.01], { position: [-1.6, 1.3, 0.135], color: "#4ade80", finish: "glow", intensity: 2 });
  b.cylinder(0.08, 0.1, 0.36, { position: [-1.05, 1.13, -0.1], color: P.charcoal, segments: 12 });
  for (let i = 0; i < 4; i++) b.cylinder(0.04, 0.035, 0.09, { position: [-0.6 + i * 0.12, 0.995, 0.1], color: P.white, finish: "gloss", segments: 10 });
  b.box([1.2, 0.4, 0.5], { position: [1.4, 1.15, -0.05], color: "#bfe6ff", finish: "gloss", radius: 0.02 });
  for (let i = 0; i < 5; i++) b.blob(0.06, { position: [0.98 + i * 0.2, 1.02, 0], color: i % 2 ? "#d97706" : "#f59e0b" });
  return b;
}

function fridge(): PartsBuilder {
  const b = new PartsBuilder();
  b.box([0.78, 1.9, 0.68], { position: [0, 0.95, 0], color: P.white, radius: 0.03, finish: "gloss" });
  b.box([0.76, 0.01, 0.01], { position: [0, 1.3, 0.345], color: P.steel });
  b.box([0.02, 0.5, 0.03], { position: [0.32, 1.55, 0.36], color: P.metal, finish: "gloss" });
  b.box([0.14, 0.05, 0.005], { position: [-0.2, 1.6, 0.343], color: P.cyan, finish: "glow", intensity: 1.8 });
  return b;
}

function waterCooler(): PartsBuilder {
  const b = new PartsBuilder();
  b.box([0.34, 0.95, 0.34], { position: [0, 0.475, 0], color: P.white, radius: 0.03 });
  b.cylinder(0.13, 0.13, 0.42, { position: [0, 1.17, 0], color: "#7cc7ff", finish: "gloss", segments: 16 });
  b.box([0.08, 0.02, 0.02], { position: [0, 0.8, 0.18], color: "#38bdf8", finish: "glow", intensity: 2 });
  return b;
}

function floorLamp(): PartsBuilder {
  const b = new PartsBuilder();
  b.cylinder(0.16, 0.18, 0.03, { position: [0, 0.015, 0], color: P.charcoal, segments: 18 });
  b.cylinder(0.012, 0.012, 1.5, { position: [0, 0.78, 0], color: P.metal, finish: "gloss", segments: 8 });
  b.cylinder(0.14, 0.2, 0.26, { position: [0, 1.6, 0], color: "#fff1d6", finish: "glow", intensity: 1.6, open: true, segments: 18 });
  return b;
}

function globe(): PartsBuilder {
  const b = new PartsBuilder();
  b.cylinder(0.16, 0.2, 0.05, { position: [0, 0.025, 0], color: P.woodDark, segments: 16 });
  b.cylinder(0.02, 0.025, 0.7, { position: [0, 0.4, 0], color: P.woodDark, segments: 8 });
  b.sphere(0.24, { position: [0, 0.98, 0], color: "#2f6fb0", segments: 20, finish: "gloss" });
  b.blob(0.12, { position: [0.1, 1.05, 0.15], color: "#4f9d5d", detail: 0 });
  b.blob(0.1, { position: [-0.14, 0.92, 0.12], color: "#4f9d5d", detail: 0 });
  b.torus(0.27, 0.01, { position: [0, 0.98, 0], rotation: [0, 0, 0.4], color: "#d6b46a", finish: "gloss", arc: Math.PI * 1.4 });
  return b;
}

function rug(): PartsBuilder {
  const b = new PartsBuilder();
  b.box([3.2, 0.012, 2.4], { position: [0, 0.006, 0], color: P.fabric, radius: 0.005 });
  b.box([2.9, 0.014, 2.1], { position: [0, 0.007, 0], color: P.offWhite, radius: 0.005 });
  return b;
}

function pendant(): PartsBuilder {
  const b = new PartsBuilder();
  b.cylinder(0.004, 0.004, 1.05, { position: [0, 3.08, 0], color: P.charcoal, segments: 4 });
  b.cylinder(0.05, 0.22, 0.2, { position: [0, 2.48, 0], color: P.charcoal, open: true, segments: 18 });
  b.cylinder(0.2, 0.2, 0.01, { position: [0, 2.39, 0], color: P.warm, finish: "glow", intensity: 3, segments: 18 });
  return b;
}

function gate(): PartsBuilder {
  const b = new PartsBuilder();
  for (const s of [-1, 1]) {
    b.box([0.2, 2.7, 0.3], { position: [s * 1.3, 1.35, 0], color: P.charcoal, radius: 0.04, finish: "gloss" });
    b.box([0.025, 2.4, 0.06], { position: [s * 1.19, 1.35, 0], color: P.cyan, finish: "glow", intensity: 3 });
  }
  b.box([2.8, 0.22, 0.3], { position: [0, 2.8, 0], color: P.charcoal, radius: 0.04, finish: "gloss" });
  b.box([2.3, 0.025, 0.06], { position: [0, 2.68, 0], color: P.cyan, finish: "glow", intensity: 3 });
  // Floor pad with a lit grid.
  b.box([2.4, 0.03, 1.2], { position: [0, 0.015, 0], color: "#141a2e", radius: 0.01 });
  for (let i = -3; i <= 3; i++) b.box([0.012, 0.004, 1.12], { position: [i * 0.32, 0.032, 0], color: P.cyan, finish: "glow", intensity: 1.4 });
  for (let i = -1; i <= 1; i++) b.box([2.3, 0.004, 0.012], { position: [0, 0.032, i * 0.38], color: P.cyan, finish: "glow", intensity: 1.4 });
  return b;
}

function bollard(): PartsBuilder {
  const b = new PartsBuilder();
  b.cylinder(0.1, 0.12, 0.7, { position: [0, 0.35, 0], color: P.charcoal, segments: 14, finish: "gloss" });
  b.cylinder(0.105, 0.105, 0.08, { position: [0, 0.58, 0], color: P.cyan, finish: "glow", intensity: 2.5, segments: 14 });
  return b;
}

const BUILDERS: Record<FurnitureType, () => PartsBuilder> = {
  desk,
  chair,
  execDesk,
  execChair,
  receptionDesk,
  plant: () => plant(3, false),
  plantTall: () => plant(11, true),
  tree,
  sofa,
  armchair,
  coffeeTable,
  roundTable: () => roundTable(0.5),
  cafeTable: () => roundTable(0.4),
  cafeChair,
  stool,
  collabTable,
  conferenceTable,
  bookshelf,
  serverRack,
  pingPong,
  beanbag,
  counter,
  fridge,
  waterCooler,
  floorLamp,
  globe,
  rug,
  pendant,
  gate,
  bollard,
};

const cache = new Map<string, BuiltParts>();

/** Built (merged) geometry for a furniture type, cached for the session. */
export function furnitureGeometry(type: FurnitureType): BuiltParts {
  let built = cache.get(type);
  if (!built) {
    built = BUILDERS[type]().build();
    cache.set(type, built);
  }
  return built;
}

export function monitorGeometry(): BuiltParts {
  let built = cache.get("monitor");
  if (!built) {
    built = monitorFrame().build();
    cache.set("monitor", built);
  }
  return built;
}

export const FURNITURE_TYPES = Object.keys(BUILDERS) as FurnitureType[];
