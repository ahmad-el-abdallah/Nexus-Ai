"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { type BufferGeometry, Color, type InstancedMesh, Matrix4, MeshBasicMaterial, PlaneGeometry, Quaternion, Vector3, Euler } from "three";
import { useThree } from "@react-three/fiber";

import { furnitureGeometry, MONITOR_SCREEN, monitorGeometry } from "../geometry/furniture";
import type { BuiltParts, Finish } from "../geometry/PartsBuilder";
import { WORKSTATIONS } from "../layout/building";
import { FLOOR_BY_ID, placementsOn, ROOM_BY_ID } from "../layout/queries";
import type { FloorId, FurnitureType, Workstation } from "../layout/types";
import { castsShadow, FINISHES, finishMaterials } from "../materials";
import { lockScreenTexture } from "../textures";

const noRaycast = () => null;
const WHITE = new Color("#ffffff");

function compose(x: number, y: number, z: number, rotY: number): Matrix4 {
  return new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromEuler(new Euler(0, rotY, 0)), new Vector3(1, 1, 1));
}

function InstancedParts({ parts, matrices, colors, label }: { parts: BuiltParts; matrices: Matrix4[]; colors: Color[]; label: string }) {
  const materials = finishMaterials();
  return (
    <>
      {FINISHES.filter((f) => parts[f]).map((finish) => (
        <InstancedFinish key={finish} name={`${label}:${finish}`} geometry={parts[finish]!} finish={finish} material={materials[finish]} matrices={matrices} colors={colors} />
      ))}
    </>
  );
}

function InstancedFinish({
  geometry,
  finish,
  material,
  matrices,
  colors,
  name,
}: {
  geometry: BufferGeometry;
  finish: Finish;
  material: ReturnType<typeof finishMaterials>[Finish];
  matrices: Matrix4[];
  colors: Color[];
  name: string;
}) {
  const ref = useRef<InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    const tinted = colors.some((c) => !c.equals(WHITE));
    if (tinted) colors.forEach((c, i) => mesh.setColorAt(i, c));
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    invalidate();
  }, [matrices, colors, invalidate]);
  const shadow = castsShadow(finish);
  return (
    <instancedMesh
      ref={ref}
      name={name}
      args={[geometry, material, matrices.length]}
      castShadow={shadow}
      receiveShadow={finish !== "glow"}
      raycast={noRaycast}
      frustumCulled={false}
    />
  );
}

const TINT_BY_DEFAULT: ReadonlySet<FurnitureType> = new Set(["chair"]);

function tintColor(hex: string | undefined): Color {
  return hex ? new Color("#ffffff").lerp(new Color(hex), 0.55) : WHITE.clone();
}

/** Monitor placement relative to a workstation (occupant on the local +z side). */
function monitorTransforms(ws: Workstation, elevation: number): Matrix4[] {
  const base = compose(ws.x, elevation, ws.z, ws.rot);
  const local: [number, number, number, number][] =
    ws.style === "reception"
      ? [[0, 0, 0.05, 0]]
      : ws.style === "executive"
        ? [[0, 0.015, -0.3, 0]]
        : ws.monitors === 2
          ? [
              [-0.34, 0, -0.2, 0.3],
              [0.34, 0, -0.2, -0.3],
            ]
          : [[0, 0, -0.22, 0]];
  return local.map(([x, y, z, yaw]) => base.clone().multiply(compose(x, y, z, yaw)));
}

/** Every piece of furniture on one floor, one instanced draw call per type and finish. */
export function Furniture({ floor }: { floor: FloorId }) {
  const elevation = FLOOR_BY_ID.get(floor)!.elevation;

  const groups = useMemo(() => {
    const byType = new Map<FurnitureType, { matrices: Matrix4[]; colors: Color[] }>();
    for (const p of placementsOn(floor)) {
      const entry = byType.get(p.type) ?? { matrices: [], colors: [] };
      entry.matrices.push(compose(p.x, elevation, p.z, p.rot));
      const tint = p.tint ?? (TINT_BY_DEFAULT.has(p.type) && p.room ? ROOM_BY_ID.get(p.room)?.accent : undefined);
      entry.colors.push(tintColor(tint));
      byType.set(p.type, entry);
    }
    return [...byType.entries()];
  }, [floor, elevation]);

  const monitors = useMemo(() => {
    const matrices = WORKSTATIONS.filter((w) => w.floor === floor).flatMap((w) => monitorTransforms(w, elevation));
    const screen = new Matrix4().makeTranslation(0, MONITOR_SCREEN.y, MONITOR_SCREEN.z);
    return { matrices, colors: matrices.map(() => WHITE.clone()), screens: matrices.map((m) => m.clone().multiply(screen)) };
  }, [floor, elevation]);

  return (
    <group name={`furniture-${floor}`}>
      {groups.map(([type, g]) => (
        <InstancedParts key={type} label={type} parts={furnitureGeometry(type)} matrices={g.matrices} colors={g.colors} />
      ))}
      {monitors.matrices.length > 0 && (
        <>
          <InstancedParts label="monitor" parts={monitorGeometry()} matrices={monitors.matrices} colors={monitors.colors} />
          <Screens matrices={monitors.screens} />
        </>
      )}
    </group>
  );
}

let screenResources: { geometry: PlaneGeometry; material: MeshBasicMaterial } | null = null;
function screenAssets() {
  if (!screenResources) {
    const { texture, redraw } = lockScreenTexture();
    const material = new MeshBasicMaterial({ map: texture, toneMapped: false });
    material.color.setScalar(0.95);
    screenResources = { geometry: new PlaneGeometry(MONITOR_SCREEN.width, MONITOR_SCREEN.height), material };
    // Redraw once web fonts are ready so the lock-screen text uses Inter.
    void document.fonts?.ready.then(() => redraw());
  }
  return screenResources;
}

function Screens({ matrices }: { matrices: Matrix4[] }) {
  const ref = useRef<InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  const { geometry, material } = screenAssets();
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    void document.fonts?.ready.then(() => invalidate());
    invalidate();
  }, [matrices, invalidate]);
  return <instancedMesh ref={ref} name="monitor-screens" args={[geometry, material, matrices.length]} raycast={noRaycast} frustumCulled={false} />;
}
