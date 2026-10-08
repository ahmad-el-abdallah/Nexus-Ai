/**
 * Character part geometry, modelled in each joint's local space. Parts are
 * mostly white so a per-instance colour (skin, hair, outfit) tints them;
 * fixed details (eyes, glasses) carry their own dark vertex colours.
 */

import type { BufferGeometry } from "three";

import { PartsBuilder } from "../geometry/PartsBuilder";
import type { Appearance, HairStyle, TopStyle } from "./appearance";
import type { Joint } from "./rig";

const W = "#ffffff";
const DARK = "#1a1c26";

/** Which appearance colour tints a part. */
export type Tint = "skin" | "hair" | "top" | "inner" | "pants" | "shoes" | "none";

export interface PartSpec {
  key: string;
  joint: Joint;
  tint: Tint;
  /** Scale x by the character's build (torso, pelvis). */
  widthByBuild?: boolean;
  /** Whether a character uses this part. */
  uses: (a: Appearance) => boolean;
  build: () => PartsBuilder;
}

const always = () => true;

function hairBuilder(style: HairStyle): PartsBuilder {
  const b = new PartsBuilder();
  const cap = (scaleY = 0.78) => b.sphere(0.124, { position: [0, 0.185, -0.012], scale: [1.04, scaleY, 1.06], color: W, segments: 14 });
  switch (style) {
    case "short":
      cap();
      b.box([0.17, 0.05, 0.05], { position: [0, 0.255, 0.085], rotation: [0.4, 0, 0], color: W, radius: 0.02 });
      break;
    case "buzz":
      b.sphere(0.119, { position: [0, 0.172, -0.005], scale: [1, 0.72, 1.02], color: W, segments: 12 });
      break;
    case "long":
      cap(0.82);
      b.box([0.25, 0.3, 0.09], { position: [0, 0.07, -0.075], color: W, radius: 0.04 });
      for (const s of [-1, 1]) b.box([0.05, 0.22, 0.09], { position: [s * 0.11, 0.1, 0.0], color: W, radius: 0.02 });
      break;
    case "bun":
      cap();
      b.sphere(0.06, { position: [0, 0.3, -0.075], color: W, segments: 10 });
      break;
    case "curly":
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        b.blob(0.06, { position: [Math.cos(a) * 0.085, 0.215 + Math.sin(i * 1.7) * 0.02, Math.sin(a) * 0.085 - 0.01], color: W, detail: 0 });
      }
      b.blob(0.075, { position: [0, 0.27, -0.01], color: W, detail: 1 });
      break;
    case "ponytail":
      cap();
      b.cylinder(0.03, 0.018, 0.2, { position: [0, 0.12, -0.14], rotation: [0.35, 0, 0], color: W, segments: 8 });
      break;
    case "bob":
      cap(0.85);
      b.box([0.26, 0.15, 0.2], { position: [0, 0.135, -0.02], color: W, radius: 0.05 });
      break;
    case "headscarf":
      b.sphere(0.134, { position: [0, 0.15, -0.04], scale: [1.04, 1.12, 1.04], color: W, segments: 16 });
      b.cylinder(0.11, 0.17, 0.1, { position: [0, 0.0, -0.01], color: W, segments: 16 });
      break;
    case "bald":
      break;
  }
  return b;
}

function torsoDetail(style: TopStyle): PartsBuilder {
  const b = new PartsBuilder();
  switch (style) {
    case "blazer":
      // Shirt and tie visible in the open front (tinted with the inner colour).
      b.box([0.1, 0.3, 0.02], { position: [0, 0.32, 0.098], color: W, radius: 0.008 });
      break;
    case "hoodie":
      b.box([0.1, 0.03, 0.02], { position: [0, 0.4, 0.105], color: W });
      break;
    case "sweater":
      b.torus(0.06, 0.018, { position: [0, 0.465, 0.0], rotation: [Math.PI / 2, 0, 0], color: W });
      break;
    case "shirt":
      b.box([0.16, 0.035, 0.12], { position: [0, 0.47, 0.03], color: W, radius: 0.012 });
      break;
  }
  return b;
}

function torsoShape(style: TopStyle): PartsBuilder {
  const b = new PartsBuilder();
  b.box([0.34, 0.47, 0.2], { position: [0, 0.24, 0], color: W, radius: 0.07 });
  if (style === "hoodie") {
    b.box([0.24, 0.12, 0.08], { position: [0, 0.45, -0.1], color: W, radius: 0.04 });
    b.box([0.2, 0.08, 0.02], { position: [0, 0.12, 0.1], color: "#e6e6e6", radius: 0.01 });
  }
  if (style === "blazer") {
    for (const s of [-1, 1]) b.box([0.04, 0.26, 0.02], { position: [s * 0.065, 0.34, 0.1], rotation: [0, 0, s * 0.25], color: "#d8d8d8", radius: 0.006 });
  }
  return b;
}

const HAIR_STYLES: HairStyle[] = ["short", "buzz", "long", "bun", "curly", "ponytail", "bob", "headscarf"];
const TOP_STYLES: TopStyle[] = ["shirt", "blazer", "hoodie", "sweater"];

export const PART_SPECS: PartSpec[] = [
  {
    key: "pelvis",
    joint: "pelvis",
    tint: "pants",
    widthByBuild: true,
    uses: always,
    build: () => new PartsBuilder().box([0.3, 0.17, 0.19], { position: [0, 0.03, 0], color: W, radius: 0.05 }),
  },
  ...TOP_STYLES.map<PartSpec>((style) => ({
    key: `torso-${style}`,
    joint: "torso",
    tint: "top",
    widthByBuild: true,
    uses: (a) => a.top === style,
    build: () => torsoShape(style),
  })),
  ...TOP_STYLES.map<PartSpec>((style) => ({
    key: `torso-detail-${style}`,
    joint: "torso",
    tint: "inner",
    uses: (a) => a.top === style,
    build: () => torsoDetail(style),
  })),
  {
    key: "head",
    joint: "head",
    tint: "skin",
    uses: always,
    build: () => {
      const b = new PartsBuilder();
      b.cylinder(0.045, 0.05, 0.08, { position: [0, 0.03, 0], color: W, segments: 10 });
      b.sphere(0.115, { position: [0, 0.155, 0], scale: [0.95, 1.05, 1], color: W, segments: 18 });
      for (const s of [-1, 1]) b.sphere(0.025, { position: [s * 0.108, 0.15, -0.005], color: W, segments: 8 });
      b.sphere(0.018, { position: [0, 0.14, 0.112], color: "#f2f2f2", segments: 8 });
      return b;
    },
  },
  {
    key: "face",
    joint: "head",
    tint: "none",
    uses: always,
    build: () => {
      const b = new PartsBuilder();
      for (const s of [-1, 1]) {
        b.sphere(0.014, { position: [s * 0.04, 0.17, 0.1], color: DARK, segments: 8 });
        b.box([0.035, 0.007, 0.01], { position: [s * 0.04, 0.2, 0.104], rotation: [0, 0, s * -0.1], color: "#3b2a24" });
      }
      b.box([0.045, 0.008, 0.01], { position: [0, 0.105, 0.106], color: "#9b4f4f", radius: 0.003 });
      return b;
    },
  },
  ...HAIR_STYLES.map<PartSpec>((style) => ({
    key: `hair-${style}`,
    joint: "head",
    tint: "hair",
    uses: (a) => a.hairStyle === style,
    build: () => hairBuilder(style),
  })),
  {
    key: "beard",
    joint: "head",
    tint: "hair",
    uses: (a) => a.beard,
    build: () =>
      new PartsBuilder()
        .sphere(0.1, { position: [0, 0.1, 0.03], scale: [1, 0.75, 0.85], color: W, segments: 12 })
        .box([0.05, 0.012, 0.012], { position: [0, 0.112, 0.112], color: W }),
  },
  {
    key: "glasses",
    joint: "head",
    tint: "none",
    uses: (a) => a.glasses,
    build: () => {
      const b = new PartsBuilder();
      for (const s of [-1, 1]) {
        b.torus(0.026, 0.005, { position: [s * 0.042, 0.17, 0.113], color: DARK });
        b.box([0.005, 0.005, 0.1], { position: [s * 0.1, 0.175, 0.065], color: DARK });
      }
      b.box([0.03, 0.005, 0.005], { position: [0, 0.175, 0.115], color: DARK });
      return b;
    },
  },
  {
    key: "headset",
    joint: "head",
    tint: "none",
    uses: (a) => a.headset,
    build: () => {
      const b = new PartsBuilder();
      b.torus(0.125, 0.009, { position: [0, 0.16, -0.005], rotation: [0, Math.PI / 2, 0], color: "#2b3045", arc: Math.PI });
      for (const s of [-1, 1]) b.cylinder(0.035, 0.035, 0.025, { position: [s * 0.122, 0.15, 0], rotation: [0, 0, Math.PI / 2], color: "#2b3045", segments: 12 });
      b.box([0.008, 0.008, 0.09], { position: [0.105, 0.11, 0.06], rotation: [0.6, -0.3, 0], color: "#2b3045" });
      b.sphere(0.012, { position: [0.085, 0.095, 0.1], color: "#22d3ee", segments: 6 });
      return b;
    },
  },
  ...(["L", "R"] as const).flatMap<PartSpec>((side) => [
    {
      key: `upperArm${side}`,
      joint: `upperArm${side}`,
      tint: "top",
      uses: always,
      build: () => new PartsBuilder().box([0.095, 0.3, 0.1], { position: [0, -0.13, 0], color: W, radius: 0.045 }),
    },
    {
      key: `forearmSleeve${side}`,
      joint: `forearm${side}`,
      tint: "top",
      uses: (a) => a.longSleeves,
      build: () => new PartsBuilder().box([0.085, 0.26, 0.09], { position: [0, -0.12, 0], color: W, radius: 0.04 }),
    },
    {
      key: `forearmSkin${side}`,
      joint: `forearm${side}`,
      tint: "skin",
      uses: (a) => !a.longSleeves,
      build: () => new PartsBuilder().box([0.07, 0.26, 0.075], { position: [0, -0.12, 0], color: W, radius: 0.034 }),
    },
    {
      key: `hand${side}`,
      joint: `hand${side}`,
      tint: "skin",
      uses: always,
      build: () => new PartsBuilder().box([0.07, 0.1, 0.045], { position: [0, -0.04, 0.005], color: W, radius: 0.022 }),
    },
    {
      key: `thigh${side}`,
      joint: `thigh${side}`,
      tint: "pants",
      uses: always,
      build: () => new PartsBuilder().box([0.135, 0.44, 0.15], { position: [0, -0.2, 0], color: W, radius: 0.06 }),
    },
    {
      key: `shin${side}`,
      joint: `shin${side}`,
      tint: "pants",
      uses: always,
      build: () => new PartsBuilder().box([0.115, 0.42, 0.125], { position: [0, -0.2, 0], color: W, radius: 0.05 }),
    },
    {
      key: `shoe${side}`,
      joint: `foot${side}`,
      tint: "shoes",
      uses: always,
      build: () =>
        new PartsBuilder()
          .box([0.11, 0.075, 0.25], { position: [0, -0.035, 0.045], color: W, radius: 0.035 })
          .box([0.112, 0.02, 0.252], { position: [0, -0.068, 0.045], color: "#bdbdbd", radius: 0.008 }),
    },
  ]),
];

const geometryCache = new Map<string, BufferGeometry | null>();

/** Merged geometry for a part (null when the part is empty, e.g. bald "hair"). */
export function partGeometry(spec: PartSpec): BufferGeometry | null {
  if (!geometryCache.has(spec.key)) {
    const builder = spec.build();
    geometryCache.set(spec.key, builder.isEmpty ? null : (builder.build().matte ?? null));
  }
  return geometryCache.get(spec.key)!;
}

export function tintColor(a: Appearance, tint: Tint): string {
  switch (tint) {
    case "skin":
      return a.skin;
    case "hair":
      return a.hairColor;
    case "top":
      return a.topColor;
    case "inner":
      return a.innerColor;
    case "pants":
      return a.pantsColor;
    case "shoes":
      return a.shoeColor;
    case "none":
      return "#ffffff";
  }
}
