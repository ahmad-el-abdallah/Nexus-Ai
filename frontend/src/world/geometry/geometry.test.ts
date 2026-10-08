import { Box3 } from "three";
import { describe, expect, it } from "vitest";

import { PLACEMENTS, WORKSTATIONS } from "../layout/building";
import { FOOTPRINTS } from "../layout/footprints";
import type { FurnitureType } from "../layout/types";
import { FURNITURE_TYPES, furnitureGeometry, monitorGeometry } from "./furniture";
import type { BuiltParts } from "./PartsBuilder";
import { buildElevator, buildPlinth, buildSlab } from "./site";
import { buildWallGroups } from "./walls";

function bounds(parts: BuiltParts): Box3 {
  const box = new Box3();
  for (const g of Object.values(parts)) {
    g.computeBoundingBox();
    box.union(g.boundingBox!);
  }
  return box;
}

function triangles(parts: BuiltParts): number {
  return Object.values(parts).reduce((sum, g) => sum + g.attributes.position.count / 3, 0);
}

describe("furniture geometry", () => {
  it.each(FURNITURE_TYPES)("%s builds with vertex colours and fits its declared footprint", (type: FurnitureType) => {
    const parts = furnitureGeometry(type);
    expect(Object.keys(parts).length).toBeGreaterThan(0);
    for (const g of Object.values(parts)) {
      expect(g.getAttribute("color")).toBeDefined();
      expect(g.getAttribute("normal")).toBeDefined();
    }
    const box = bounds(parts);
    const [w, d] = FOOTPRINTS[type];
    const tolerance = 0.06;
    expect(box.min.x, "min x").toBeGreaterThanOrEqual(-w / 2 - tolerance);
    expect(box.max.x, "max x").toBeLessThanOrEqual(w / 2 + tolerance);
    expect(box.min.z, "min z").toBeGreaterThanOrEqual(-d / 2 - tolerance);
    expect(box.max.z, "max z").toBeLessThanOrEqual(d / 2 + tolerance);
    expect(box.min.y, "sits on the floor").toBeGreaterThanOrEqual(-0.01);
  });

  it("stays within the triangle budget for the whole building", () => {
    const perType = new Map<string, number>();
    for (const p of PLACEMENTS) perType.set(p.type, (perType.get(p.type) ?? 0) + 1);
    let total = 0;
    for (const [type, count] of perType) total += triangles(furnitureGeometry(type as FurnitureType)) * count;
    const monitors = WORKSTATIONS.reduce((n, w) => n + w.monitors, 0);
    total += triangles(monitorGeometry()) * monitors;
    // Budget for an integrated GPU: furniture under 220k triangles.
    expect(total).toBeLessThan(220_000);
  });
});

describe("architecture geometry", () => {
  it("builds wall groups that can cut away, plus static glass groups", () => {
    const groups = buildWallGroups();
    const cuttable = groups.filter((g) => g.cutNormal);
    const statics = groups.filter((g) => !g.cutNormal);
    expect(cuttable.length).toBeGreaterThanOrEqual(6);
    for (const g of cuttable) expect(g.cut, g.key).not.toBeNull();
    for (const g of statics) expect(g.cut, g.key).toBeNull();
    // Exterior walls carry windows (glass) and an LED cove (glow).
    const back = groups.find((g) => g.key === "L1:0,-1")!;
    expect(back.full.glass).toBeDefined();
    expect(back.full.glow).toBeDefined();
  });

  it("builds the plinth, slabs and elevator", () => {
    expect(bounds(buildPlinth()).max.x).toBeCloseTo(20, 0);
    expect(bounds(buildSlab("L2")).max.y).toBeCloseTo(3.85, 1);
    expect(buildElevator().glass).toBeDefined();
  });
});
