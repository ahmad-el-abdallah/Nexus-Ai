/**
 * Deterministic avatar generator: the same seed always produces the same
 * person, so appearances persist with nothing but the employee's avatar_seed.
 */

export type HairStyle = "short" | "buzz" | "long" | "bun" | "curly" | "ponytail" | "bob" | "bald" | "headscarf";
export type TopStyle = "shirt" | "blazer" | "hoodie" | "sweater";

export interface Appearance {
  skin: string;
  hairStyle: HairStyle;
  hairColor: string;
  /** Uniform scale around 1.0. */
  height: number;
  /** Shoulder / hip width multiplier. */
  build: number;
  top: TopStyle;
  topColor: string;
  innerColor: string;
  longSleeves: boolean;
  pantsColor: string;
  shoeColor: string;
  glasses: boolean;
  headset: boolean;
  beard: boolean;
}

export const SKIN_TONES = ["#f6d7c3", "#ecc4a4", "#dcaa84", "#c48a62", "#a06a48", "#7d4c33", "#5e3725"];
const HAIR_COLORS = ["#16100c", "#2e1d14", "#4d311f", "#7a4e2c", "#b98a52", "#d8c08f", "#8a8a8f", "#3a2a4a"];
const HAIR_STYLES: HairStyle[] = ["short", "buzz", "long", "bun", "curly", "ponytail", "bob", "bald", "headscarf"];
const TOPS: TopStyle[] = ["shirt", "blazer", "hoodie", "sweater"];
const NEUTRALS = ["#e5e7eb", "#1f2937", "#334155", "#f1f5f9", "#0f172a", "#475569"];
const PANTS = ["#1e293b", "#273449", "#3f3f46", "#44403c", "#1f2a44", "#57534e"];
const SHOES = ["#111827", "#3f2a1d", "#e5e7eb", "#1e293b"];
const SCARVES = ["#7c3aed", "#0f766e", "#be185d", "#1d4ed8", "#b45309"];

/** Department colour families keep teams visually related but not uniform. */
const DEPARTMENT_TONES: Record<string, string[]> = {
  executive: ["#4c1d95", "#6d28d9", "#1e1b4b", "#312e81"],
  sales: ["#b45309", "#d97706", "#92400e", "#a16207"],
  marketing: ["#be185d", "#db2777", "#9d174d", "#c026d3"],
  engineering: ["#0e7490", "#0891b2", "#155e75", "#1d4ed8"],
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)];

export function generateAppearance(seed: number, department = ""): Appearance {
  const r = mulberry32(seed * 2654435761);
  const hairStyle = pick(r, HAIR_STYLES);
  const tones = DEPARTMENT_TONES[department] ?? NEUTRALS;
  const top = pick(r, TOPS);
  const coloured = r() < 0.65;
  return {
    skin: pick(r, SKIN_TONES),
    hairStyle,
    hairColor: hairStyle === "headscarf" ? pick(r, SCARVES) : pick(r, HAIR_COLORS),
    height: 0.94 + r() * 0.12,
    build: 0.92 + r() * 0.16,
    top,
    topColor: coloured ? pick(r, tones) : pick(r, NEUTRALS),
    innerColor: pick(r, ["#f8fafc", "#e2e8f0", "#cbd5e1", "#fde68a"]),
    longSleeves: top !== "shirt" || r() < 0.5,
    pantsColor: pick(r, PANTS),
    shoeColor: pick(r, SHOES),
    glasses: r() < 0.3,
    headset: department === "sales" ? r() < 0.6 : r() < 0.12,
    beard: hairStyle !== "headscarf" && hairStyle !== "long" && hairStyle !== "bun" && hairStyle !== "ponytail" && hairStyle !== "bob" && r() < 0.35,
  };
}

/** Two-letter initials for HUD avatars. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
