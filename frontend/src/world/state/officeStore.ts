import { create } from "zustand";

import { floorSelectionFor, isRoomVisible, ROOM_BY_ID } from "../layout/queries";
import type { ActiveFloor } from "../layout/types";

export type ViewMode = "3d" | "2d";
export type Quality = "high" | "balanced" | "low";
export type WebGLState = "unknown" | "supported" | "unsupported" | "lost";

export type CameraRequest =
  | { kind: "overview"; nonce: number }
  | { kind: "floor"; nonce: number }
  | { kind: "room"; roomId: string; nonce: number }
  | { kind: "zoom"; factor: number; nonce: number }
  | { kind: "rotate"; angle: number; nonce: number };

export interface OfficeState {
  activeFloor: ActiveFloor;
  selectedRoomId: string | null;
  hoveredRoomId: string | null;
  view: ViewMode;
  webgl: WebGLState;
  quality: Quality;
  showPerf: boolean;
  cameraRequest: CameraRequest | null;

  selectRoom: (roomId: string | null) => void;
  hoverRoom: (roomId: string | null) => void;
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

export const useOfficeStore = create<OfficeState>((set, get) => ({
  activeFloor: "all",
  selectedRoomId: null,
  hoveredRoomId: null,
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
      activeFloor: floorSelectionFor(room, get().activeFloor),
      cameraRequest: { kind: "room", roomId, nonce: ++nonce },
    });
  },

  hoverRoom: (roomId) => {
    if (get().hoveredRoomId !== roomId) set({ hoveredRoomId: roomId });
  },

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
    set({ activeFloor: "all", selectedRoomId: null, hoveredRoomId: null, cameraRequest: { kind: "overview", nonce: ++nonce } }),

  zoomBy: (factor) => set({ cameraRequest: { kind: "zoom", factor, nonce: ++nonce } }),
  rotateBy: (angle) => set({ cameraRequest: { kind: "rotate", angle, nonce: ++nonce } }),
  setView: (view) => set({ view, hoveredRoomId: null }),
  setWebGL: (webgl) => set(webgl === "unsupported" || webgl === "lost" ? { webgl, view: "2d" } : { webgl }),
  setQuality: (quality) => set({ quality }),
  togglePerf: () => set({ showPerf: !get().showPerf }),
}));
