import { DoubleSide, type Material, MeshBasicMaterial, MeshLambertMaterial, MeshStandardMaterial } from "three";

import type { Finish } from "./geometry/PartsBuilder";

/**
 * How a material is drawn. three.js recomputes shader parameters whenever one
 * material alternates between plain, instanced and instance-coloured meshes,
 * so each usage gets its own material instance (measured: ~20% of frame CPU).
 */
export type MaterialUse = "mesh" | "instanced" | "instancedColor";

const shared = new Map<MaterialUse, Record<Finish, Material>>();

/** One material per finish and usage, shared by every matching mesh in the scene. */
export function finishMaterials(use: MaterialUse = "mesh"): Record<Finish, Material> {
  let set = shared.get(use);
  if (!set) {
    set = {
      // Lambert for the large matte surfaces: far cheaper per pixel than PBR on integrated GPUs.
      matte: new MeshLambertMaterial({ vertexColors: true }),
      gloss: new MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.25, envMapIntensity: 1.2 }),
      glow: new MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
      glass: new MeshStandardMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.2,
        roughness: 0.04,
        metalness: 0.1,
        envMapIntensity: 1.6,
        depthWrite: false,
        side: DoubleSide,
        // Thin panes don't need back-then-front two-pass rendering, and that path
        // flips material.side with needsUpdate on every draw (shader re-evaluation).
        forceSinglePass: true,
      }),
    };
    set.glass.name = "glass";
    shared.set(use, set);
  }
  return set;
}

export const FINISHES: Finish[] = ["matte", "gloss", "glow", "glass"];

/** Glass and glow surfaces shouldn't darken the scene with shadows. */
export function castsShadow(finish: Finish): boolean {
  return finish === "matte" || finish === "gloss";
}

/**
 * Only opaque finishes receive shadows. Keep this identical for every mesh
 * sharing a material, or three.js keeps switching shader variants.
 */
export const receivesShadow = castsShadow;
