"use client";

import { type ThreeEvent, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Color, MeshBasicMaterial, MeshLambertMaterial, MeshStandardMaterial, PlaneGeometry, type Texture } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import { ROOMS } from "../layout/building";
import { FLOOR_BY_ID, isRoomVisible, rectCenter } from "../layout/queries";
import type { FloorFinish, FloorId, RoomDef } from "../layout/types";
import { useOfficeStore } from "../state/officeStore";
import { FINISH_TILE, floorTexture } from "../textures";
import { ScreenLabel } from "./screenAnchors";

/** Drags longer than this (px) are camera pans, not clicks. */
const CLICK_TOLERANCE = 6;

const ROUGHNESS: Record<FloorFinish, number> = {
  carpet: 0.95,
  "carpet-indigo": 0.95,
  stone: 0.32,
  wood: 0.55,
  tile: 0.38,
};

const baseTextures = new Map<FloorFinish, Texture>();
function finishTexture(finish: FloorFinish): Texture {
  let t = baseTextures.get(finish);
  if (!t) {
    t = floorTexture(finish);
    baseTextures.set(finish, t);
  }
  return t;
}

function RoomSurface({ room }: { room: RoomDef }) {
  const floor = FLOOR_BY_ID.get(room.floor)!;
  const selected = useOfficeStore((s) => s.selectedRoomId === room.id);
  const hovered = useOfficeStore((s) => s.hoveredRoomId === room.id);
  const visible = useOfficeStore((s) => isRoomVisible(room, s.activeFloor));
  const selectRoom = useOfficeStore((s) => s.selectRoom);
  const hoverRoom = useOfficeStore((s) => s.hoverRoom);
  const invalidate = useThree((s) => s.invalidate);

  const w = room.rect.x1 - room.rect.x0;
  const d = room.rect.z1 - room.rect.z0;
  const [cx, cz] = rectCenter(room.rect);

  const floorMaterial = useMemo(() => {
    const map = finishTexture(room.finish).clone();
    map.needsUpdate = true;
    map.repeat.set(w / FINISH_TILE[room.finish], d / FINISH_TILE[room.finish]);
    // Only polished finishes need PBR reflections; carpet and tile use cheap Lambert shading.
    return room.finish === "stone" || room.finish === "wood"
      ? new MeshStandardMaterial({ map, roughness: ROUGHNESS[room.finish], metalness: 0.02, envMapIntensity: 0.6 })
      : new MeshLambertMaterial({ map });
  }, [room.finish, w, d]);

  const accent = useMemo(() => new Color(room.accent), [room.accent]);
  const edgeMaterial = useMemo(() => new MeshBasicMaterial({ color: accent.clone(), transparent: true, toneMapped: false }), [accent]);
  const fillMaterial = useMemo(() => new MeshBasicMaterial({ color: accent.clone(), transparent: true, depthWrite: false, toneMapped: false }), [accent]);

  useEffect(() => {
    edgeMaterial.opacity = selected ? 1 : hovered ? 0.85 : 0.4;
    edgeMaterial.color.copy(accent).multiplyScalar(selected ? 2.2 : hovered ? 1.6 : 1);
    fillMaterial.opacity = selected ? 0.12 : hovered ? 0.08 : 0;
    fillMaterial.visible = selected || hovered;
    invalidate();
  }, [selected, hovered, accent, edgeMaterial, fillMaterial, invalidate]);

  useEffect(
    () => () => {
      floorMaterial.map?.dispose();
      floorMaterial.dispose();
      edgeMaterial.dispose();
      fillMaterial.dispose();
    },
    [floorMaterial, edgeMaterial, fillMaterial],
  );

  useEffect(() => {
    if (hovered) document.body.style.cursor = "pointer";
    return () => {
      if (hovered) document.body.style.cursor = "";
    };
  }, [hovered]);

  const y = floor.elevation;
  // Accent outline inset from the walls, merged into one flat geometry.
  const edgeGeometry = useMemo(() => {
    const inset = 0.22;
    const t = 0.07;
    const strips: [number, number, number, number][] = [
      [cx, cz - d / 2 + inset, w - inset * 2, t],
      [cx, cz + d / 2 - inset, w - inset * 2, t],
      [cx - w / 2 + inset, cz, t, d - inset * 2],
      [cx + w / 2 - inset, cz, t, d - inset * 2],
    ];
    const parts = strips.map(([x, z, sw, sd]) => new PlaneGeometry(sw, sd).rotateX(-Math.PI / 2).translate(x, 0, z));
    const merged = mergeGeometries(parts)!;
    parts.forEach((p) => p.dispose());
    return merged;
  }, [cx, cz, w, d]);
  useEffect(() => () => edgeGeometry.dispose(), [edgeGeometry]);

  return (
    <group name={`room-${room.id}`}>
      <mesh
        name={`room-floor-${room.id}`}
        position={[cx, y + 0.003, cz]}
        rotation={[-Math.PI / 2, 0, 0]}
        material={floorMaterial}
        receiveShadow
        onPointerOver={(e: ThreeEvent<PointerEvent>) => {
          if (!visible) return;
          e.stopPropagation();
          hoverRoom(room.id);
        }}
        onPointerOut={() => {
          if (useOfficeStore.getState().hoveredRoomId === room.id) hoverRoom(null);
        }}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          if (!visible || e.delta > CLICK_TOLERANCE) return;
          e.stopPropagation();
          selectRoom(room.id);
        }}
      >
        <planeGeometry args={[w, d]} />
      </mesh>
      <mesh geometry={edgeGeometry} position={[0, y + 0.012, 0]} material={edgeMaterial} raycast={() => null} />
      <mesh position={[cx, y + 0.008, cz]} rotation={[-Math.PI / 2, 0, 0]} material={fillMaterial} raycast={() => null}>
        <planeGeometry args={[w, d]} />
      </mesh>
    </group>
  );
}

function RoomLabel({ room }: { room: RoomDef }) {
  const floor = FLOOR_BY_ID.get(room.floor)!;
  const visible = useOfficeStore((s) => s.view === "3d" && isRoomVisible(room, s.activeFloor));
  const selected = useOfficeStore((s) => s.selectedRoomId === room.id);
  const hovered = useOfficeStore((s) => s.hoveredRoomId === room.id);
  const selectRoom = useOfficeStore((s) => s.selectRoom);
  const hoverRoom = useOfficeStore((s) => s.hoverRoom);
  const [cx, cz] = rectCenter(room.rect);
  return (
    <ScreenLabel layer="office" point={[cx, floor.elevation + 2.9, cz]} className="pointer-events-none" style={{ display: visible ? "block" : "none" }}>
      <button
        type="button"
        data-room-label={room.id}
        tabIndex={visible ? 0 : -1}
        onClick={() => selectRoom(room.id)}
        onPointerEnter={() => hoverRoom(room.id)}
        onPointerLeave={() => hoverRoom(null)}
        className={`pointer-events-auto flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium whitespace-nowrap shadow-lg ring-1 backdrop-blur-md transition ${
          selected
            ? "bg-nx-bg/90 text-white ring-white/40"
            : hovered
              ? "bg-nx-bg/85 text-white ring-white/25"
              : "bg-nx-bg/70 text-nx-text ring-white/10"
        }`}
        style={{ boxShadow: selected ? `0 0 24px ${room.accent}66` : undefined }}
      >
        <span className="size-2 rounded-full" style={{ background: room.accent, boxShadow: `0 0 8px ${room.accent}` }} />
        {room.name}
      </button>
    </ScreenLabel>
  );
}

export function Rooms({ floor }: { floor: FloorId }) {
  const rooms = ROOMS.filter((r) => r.floor === floor);
  return (
    <>
      {rooms.map((room) => (
        <RoomSurface key={room.id} room={room} />
      ))}
    </>
  );
}

/** Room name labels as page DOM over the canvas (see screenAnchors.tsx). */
export function RoomLabels() {
  return (
    <>
      {ROOMS.map((room) => (
        <RoomLabel key={room.id} room={room} />
      ))}
    </>
  );
}
