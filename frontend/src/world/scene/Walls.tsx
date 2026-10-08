"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { type Group, MeshBasicMaterial, PlaneGeometry, Vector3 } from "three";

import { buildWallGroups, DOOR_HEIGHT, outsideSign, wallGroupKey, wallRotation, WALL_THICKNESS, type WallGroupGeometry } from "../geometry/walls";
import { WALL_ITEMS, WALLS } from "../layout/building";
import { FLOOR_BY_ID, pointOnWall } from "../layout/queries";
import type { FloorId, Opening, WallDef, WallItemDef } from "../layout/types";
import { PartsBuilder } from "../geometry/PartsBuilder";
import { castsShadow, FINISHES, finishMaterials, receivesShadow } from "../materials";
import { useOfficeStore } from "../state/officeStore";
import { drawnTexture, drawWallItem, wallItemCanvasSize } from "../textures";
import { requestShadowUpdate } from "./runtime";

const noRaycast = () => null;

let groupsCache: WallGroupGeometry[] | null = null;
function wallGroups(): WallGroupGeometry[] {
  groupsCache ??= buildWallGroups();
  return groupsCache;
}

/** Cut a wall when the camera views it from its outside within this cosine. */
const CUT_THRESHOLD = 0.2;

function PartsMeshes({ parts, name }: { parts: WallGroupGeometry["full"]; name: string }) {
  const materials = finishMaterials();
  return (
    <>
      {FINISHES.filter((f) => parts[f]).map((f) => (
        <mesh
          key={f}
          name={`${name}:${f}`}
          geometry={parts[f]}
          material={materials[f]}
          castShadow={castsShadow(f)}
          receiveShadow={receivesShadow(f)}
          raycast={noRaycast}
        />
      ))}
    </>
  );
}

function WallGroup({ group }: { group: WallGroupGeometry }) {
  const fullRef = useRef<Group>(null);
  const cutRef = useRef<Group>(null);
  const cutState = useRef<boolean | null>(null);
  const toCamera = useMemo(() => new Vector3(), []);
  const items = useMemo(() => WALL_ITEMS.filter((i) => wallGroupKey(i.wall) === group.key), [group.key]);
  const doors = useMemo(
    () =>
      WALLS.filter((w) => wallGroupKey(w.id) === group.key).flatMap((w) =>
        (w.openings ?? []).filter((o) => o.door !== "none").map((o) => ({ wall: w, opening: o })),
      ),
    [group.key],
  );

  useFrame(({ camera }) => {
    if (!group.cutNormal) return;
    camera.getWorldDirection(toCamera).negate();
    const facing = group.cutNormal[0] * toCamera.x + group.cutNormal[1] * toCamera.z;
    const len = Math.hypot(toCamera.x, toCamera.z) || 1;
    const cut = facing / len > CUT_THRESHOLD;
    if (cut === cutState.current) return;
    cutState.current = cut;
    if (fullRef.current) fullRef.current.visible = !cut;
    if (cutRef.current) cutRef.current.visible = cut;
    requestShadowUpdate();
  });

  return (
    <group name={`walls-${group.key}`}>
      <group ref={fullRef}>
        <PartsMeshes parts={group.full} name={`wall-${group.key}`} />
        {items.map((item) => (
          <WallItem key={item.id} item={item} />
        ))}
        {doors.map(({ wall, opening }) => (
          <Door key={`${wall.id}-${opening.at}`} wall={wall} opening={opening} />
        ))}
      </group>
      {group.cut && (
        <group ref={cutRef} visible={false}>
          <PartsMeshes parts={group.cut} name={`wall-cut-${group.key}`} />
        </group>
      )}
    </group>
  );
}

export function Walls({ floor }: { floor: FloorId }) {
  return (
    <>
      {wallGroups()
        .filter((g) => g.floor === floor)
        .map((g) => (
          <WallGroup key={g.key} group={g} />
        ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Wall-mounted screens and signs
// ---------------------------------------------------------------------------

function WallItem({ item }: { item: WallItemDef }) {
  const invalidate = useThree((s) => s.invalidate);
  const wall = WALLS.find((w) => w.id === item.wall)!;
  const floor = FLOOR_BY_ID.get(wall.floor)!;
  const p = pointOnWall(wall, item.at);
  const offset = WALL_THICKNESS / 2 + 0.035;
  const position: [number, number, number] = [p.x + item.facing[0] * offset, floor.elevation + item.y, p.z + item.facing[1] * offset];
  const rotationY = Math.atan2(item.facing[0], item.facing[1]);

  const resources = useMemo(() => {
    const [w, h] = wallItemCanvasSize(item.width, item.height);
    const drawn = drawnTexture(w, h, (ctx, cw, ch) => drawWallItem(ctx, cw, ch, item.content, item.accent, new Date()));
    const material = new MeshBasicMaterial({ map: drawn.texture, toneMapped: false, transparent: true });
    material.color.setScalar(item.content.kind === "sign" || item.content.kind === "logo" ? 1.15 : 0.95);
    return { ...drawn, material, geometry: new PlaneGeometry(item.width, item.height) };
  }, [item]);

  useEffect(() => {
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (cancelled) return;
      resources.redraw();
      invalidate();
    });
    // The clock shows the real time; refresh it every 20 seconds.
    const timer =
      item.content.kind === "clock"
        ? window.setInterval(() => {
            resources.redraw();
            invalidate();
          }, 20_000)
        : undefined;
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [item.content.kind, resources, invalidate]);

  useEffect(
    () => () => {
      resources.texture.dispose();
      resources.material.dispose();
      resources.geometry.dispose();
    },
    [resources],
  );

  return (
    <group position={position} rotation={[0, rotationY, 0]} name={`wall-item-${item.id}`}>
      <mesh position={[0, 0, -0.02]} raycast={noRaycast} castShadow>
        <boxGeometry args={[item.width + 0.06, item.height + 0.06, 0.04]} />
        <meshStandardMaterial color="#0d1122" roughness={0.35} metalness={0.4} />
      </mesh>
      <mesh geometry={resources.geometry} material={resources.material} raycast={noRaycast} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Sliding glass doors: open while one of their rooms is hovered or selected
// ---------------------------------------------------------------------------

function Door({ wall, opening }: { wall: WallDef; opening: Opening }) {
  const floor = FLOOR_BY_ID.get(wall.floor)!;
  const open = useOfficeStore((s) => opening.rooms.some((r) => r === s.hoveredRoomId || r === s.selectedRoomId));
  const invalidate = useThree((s) => s.invalidate);
  const leaves = useRef<(Group | null)[]>([]);
  const progress = useRef(0);
  const double = opening.door === "slide-double";
  const leafWidth = double ? opening.width / 2 : opening.width;
  const solid = wall.kind === "solid" || wall.kind === "exterior";
  const inset = solid ? WALL_THICKNESS / 2 + 0.03 : 0.045;
  // Leaves slide along the inside face of the wall.
  const side = wall.cutNormal ? -outsideSign(wall) : -1;

  useEffect(() => invalidate(), [open, invalidate]);

  useFrame((_, dt) => {
    const target = open ? 1 : 0;
    if (Math.abs(progress.current - target) < 0.001) return;
    progress.current += (target - progress.current) * Math.min(1, dt * 7);
    if (Math.abs(progress.current - target) < 0.002) progress.current = target;
    const slide = progress.current * leafWidth * 0.92;
    leaves.current.forEach((leaf, i) => {
      if (!leaf) return;
      const dir = double ? (i === 0 ? -1 : 1) : -1;
      const home = double ? (i === 0 ? -leafWidth / 2 : leafWidth / 2) : 0;
      leaf.position.x = opening.at + home + dir * slide;
    });
    invalidate();
  });

  const materials = finishMaterials();
  const count = double ? 2 : 1;
  const leafParts = useMemo(() => {
    const b = new PartsBuilder();
    b.box([leafWidth - 0.02, DOOR_HEIGHT - 0.04, 0.03], { color: "#a8e8ff", finish: "glass" });
    for (const edge of [-1, 1]) b.box([0.03, DOOR_HEIGHT - 0.04, 0.045], { position: [edge * (leafWidth / 2 - 0.025), 0, 0], color: "#1c2340", finish: "gloss" });
    b.box([0.02, 0.5, 0.06], { position: [0, -0.1, 0], color: "#9aa6c6", finish: "gloss" });
    return b.build();
  }, [leafWidth]);
  return (
    <group position={[wall.from[0], floor.elevation, wall.from[1]]} rotation={[0, wallRotation(wall), 0]}>
      {Array.from({ length: count }, (_, i) => (
        <group
          key={i}
          ref={(g) => {
            leaves.current[i] = g;
          }}
          position={[opening.at + (double ? (i === 0 ? -leafWidth / 2 : leafWidth / 2) : 0), DOOR_HEIGHT / 2, side * inset]}
        >
          <mesh geometry={leafParts.glass} material={materials.glass} raycast={noRaycast} />
          <mesh geometry={leafParts.gloss} material={materials.gloss} raycast={noRaycast} castShadow receiveShadow />
        </group>
      ))}
    </group>
  );
}
