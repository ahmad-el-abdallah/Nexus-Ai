import { create } from "zustand";

import { officeWorld } from "../characters/world";
import { FLOOR_BY_ID, floorSelectionFor, isFloorVisible, isRoomVisible, rectContains, ROOM_BY_ID } from "../layout/queries";
import type { ActiveFloor, FloorId } from "../layout/types";

export type ViewMode = "3d" | "2d";
export type Quality = "high" | "balanced" | "low";
export type WebGLState = "unknown" | "supported" | "unsupported" | "lost";

export type CameraRequest =
  | { kind: "overview"; nonce: number }
  | { kind: "floor"; nonce: number }
  | { kind: "room"; roomId: string; nonce: number }
  | { kind: "employee"; employeeId: string; nonce: number }
  | { kind: "zoom"; factor: number; nonce: number }
  | { kind: "rotate"; angle: number; nonce: number };

export interface OfficeState {
  activeFloor: ActiveFloor;
  selectedRoomId: string | null;
  hoveredRoomId: string | null;
  selectedEmployeeId: string | null;
  hoveredEmployeeId: string | null;
  /** Decorative ambient motion (idle breathing, breaks). Never affects status. */
  ambient: boolean;
  view: ViewMode;
  webgl: WebGLState;
  quality: Quality;
  showPerf: boolean;
  cameraRequest: CameraRequest | null;

  selectRoom: (roomId: string | null) => void;
  hoverRoom: (roomId: string | null) => void;
  selectEmployee: (employeeId: string | null, focus?: boolean) => void;
  hoverEmployee: (employeeId: string | null) => void;
  setAmbient: (on: boolean) => void;
  setActiveFloor: (floor: ActiveFloor) => void;
  resetView: () => void;
  zoomBy: (factor: number) => void;
  rotateBy: (angle: number) => void;
  setView: (view: ViewMode) => void;
  setWebGL: (state: WebGLState) => void;
  setQuality: (quality: Quality) => void;
  togglePerf: () => void;
}

let nonce = 0;

/** Floor selection needed to see a point on `floor` (keeps the current one when possible). */
function floorShowing(floor: FloorId, x: number, z: number, active: ActiveFloor): ActiveFloor {
  if (!isFloorVisible(floor, active)) return floor;
  const above = [...FLOOR_BY_ID.values()].filter((f) => f.level > FLOOR_BY_ID.get(floor)!.level && isFloorVisible(f.id, active));
  const covered = above.some((f) => rectContains(f.footprint, { x0: x, z0: z, x1: x, z1: z }));
  return covered ? floor : active;
}

export const useOfficeStore = create<OfficeState>((set, get) => ({
  activeFloor: "all",
  selectedRoomId: null,
  hoveredRoomId: null,
  selectedEmployeeId: null,
  hoveredEmployeeId: null,
  ambient: true,
  view: "3d",
  webgl: "unknown",
  quality: "balanced",
  showPerf: false,
  cameraRequest: null,

  selectRoom: (roomId) => {
    if (roomId === null) {
      set({ selectedRoomId: null });
      return;
    }
    const room = ROOM_BY_ID.get(roomId);
    if (!room) return;
    set({
      selectedRoomId: roomId,
      selectedEmployeeId: null,
      activeFloor: floorSelectionFor(room, get().activeFloor),
      cameraRequest: { kind: "room", roomId, nonce: ++nonce },
    });
  },

  hoverRoom: (roomId) => {
    if (get().hoveredRoomId !== roomId) set({ hoveredRoomId: roomId });
  },

  selectEmployee: (employeeId, focus = true) => {
    if (employeeId === null) {
      set({ selectedEmployeeId: null });
      return;
    }
    const c = officeWorld.residents.get(employeeId)?.controller;
    set({
      selectedEmployeeId: employeeId,
      selectedRoomId: null,
      activeFloor: c?.visible ? floorShowing(c.floor, c.x, c.z, get().activeFloor) : get().activeFloor,
      cameraRequest: focus ? { kind: "employee", employeeId, nonce: ++nonce } : get().cameraRequest,
    });
  },

  hoverEmployee: (employeeId) => {
    if (get().hoveredEmployeeId !== employeeId) set({ hoveredEmployeeId: employeeId });
  },

  setAmbient: (ambient) => set({ ambient }),

  setActiveFloor: (floor) => {
    const selected = get().selectedRoomId;
    const room = selected ? ROOM_BY_ID.get(selected) : undefined;
    set({
      activeFloor: floor,
      selectedRoomId: room && isRoomVisible(room, floor) ? selected : null,
      hoveredRoomId: null,
      cameraRequest: floor === "all" ? { kind: "overview", nonce: ++nonce } : { kind: "floor", nonce: ++nonce },
    });
  },

  resetView: () =>
    set({
      activeFloor: "all",
      selectedRoomId: null,
      hoveredRoomId: null,
      selectedEmployeeId: null,
      cameraRequest: { kind: "overview", nonce: ++nonce },
    }),

  zoomBy: (factor) => set({ cameraRequest: { kind: "zoom", factor, nonce: ++nonce } }),
  rotateBy: (angle) => set({ cameraRequest: { kind: "rotate", angle, nonce: ++nonce } }),
  setView: (view) => set({ view, hoveredRoomId: null }),
  setWebGL: (webgl) => set(webgl === "unsupported" || webgl === "lost" ? { webgl, view: "2d" } : { webgl }),
  setQuality: (quality) => set({ quality }),
  togglePerf: () => set({ showPerf: !get().showPerf }),
}));
