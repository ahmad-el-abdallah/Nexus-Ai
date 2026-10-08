import { DoubleSide, type Material, MeshBasicMaterial, MeshLambertMaterial, MeshStandardMaterial } from "three";

import type { Finish } from "./geometry/PartsBuilder";

let shared: Record<Finish, Material> | null = null;

/** One material per finish, shared by every mesh in the scene. */
export function finishMaterials(): Record<Finish, Material> {
  if (!shared) {
    shared = {
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
      }),
    };
    shared.glass.name = "glass";
  }
  return shared;
}

export const FINISHES: Finish[] = ["matte", "gloss", "glow", "glass"];

/** Glass and glow surfaces shouldn't darken the scene with shadows. */
export function castsShadow(finish: Finish): boolean {
  return finish === "matte" || finish === "gloss";
}
