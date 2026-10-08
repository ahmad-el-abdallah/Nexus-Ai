"use client";

import { CameraControls, CameraControlsImpl } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import { Box3, type OrthographicCamera, Vector3 } from "three";

import { DEFAULT_AZIMUTH, DEFAULT_POLAR, fitBox, hudInsets, MAX_POLAR, MIN_POLAR, orientationFor } from "../camera/fit";
import { MONITOR_SCREEN } from "../geometry/furniture";
import { SITE_BOUNDS, WORKSTATIONS } from "../layout/building";
import { officeWorld } from "../characters/world";
import { FLOOR_BY_ID, ROOM_BY_ID } from "../layout/queries";
import { cameraInfo } from "./runtime";
import { useEmployeeStore } from "../state/employeeStore";
import { type CameraRequest, useOfficeStore } from "../state/officeStore";
import { drawnScreens } from "./DeskScreens";

const { ACTION } = CameraControlsImpl;
const SITE_BOX = new Box3(new Vector3(...SITE_BOUNDS.min), new Vector3(...SITE_BOUNDS.max));
const PAN_BOUNDARY = new Box3(new Vector3(-24, -2, -18), new Vector3(24, 10, 20));

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

export function CameraRig() {
  const controlsRef = useRef<CameraControlsImpl>(null);
  const size = useThree((s) => s.size);
  const camera = useThree((s) => s.camera) as OrthographicCamera;
  const invalidate = useThree((s) => s.invalidate);
  const request = useOfficeStore((s) => s.cameraRequest);
  const lastFit = useRef<CameraRequest | null>({ kind: "overview", nonce: -1 });
  const overviewZoom = useRef(1);

  const run = useCallback(
    (req: CameraRequest, animate: boolean) => {
      const controls = controlsRef.current;
      if (!controls) return;
      const state = useOfficeStore.getState();
      const viewport = { width: size.width, height: size.height };
      const insets = hudInsets(size.width, size.height, state.selectedRoomId !== null || state.selectedEmployeeId !== null);
      const current = orientationFor(controls.azimuthAngle, controls.polarAngle);

      const frame = (box: Box3, orientation = current, padding = 24) => {
        const fit = fitBox(box, orientation, viewport, insets, padding);
        void controls.moveTo(fit.target.x, fit.target.y, fit.target.z, animate);
        void controls.zoomTo(fit.zoom, animate);
      };

      const overview = () => {
        const fit = fitBox(SITE_BOX, orientationFor(DEFAULT_AZIMUTH, DEFAULT_POLAR), viewport, insets, 16);
        overviewZoom.current = fit.zoom;
        cameraInfo.overviewZoom = fit.zoom;
        controls.minZoom = fit.zoom * 0.55;
        controls.maxZoom = fit.zoom * 8;
        void controls.rotateTo(DEFAULT_AZIMUTH, DEFAULT_POLAR, animate);
        void controls.moveTo(fit.target.x, fit.target.y, fit.target.z, animate);
        void controls.zoomTo(fit.zoom, animate);
        lastFit.current = req;
      };

      switch (req.kind) {
        case "overview":
          overview();
          break;
        case "floor": {
          const active = state.activeFloor;
          if (active === "all") {
            overview();
            break;
          }
          const floor = FLOOR_BY_ID.get(active)!;
          const { x0, z0, x1, z1 } = floor.footprint;
          frame(new Box3(new Vector3(x0, floor.elevation - 0.3, z0), new Vector3(x1, floor.elevation + floor.height, z1)));
          lastFit.current = req;
          break;
        }
        case "room": {
          const room = ROOM_BY_ID.get(req.roomId);
          if (!room) return;
          const floor = FLOOR_BY_ID.get(room.floor)!;
          const { x0, z0, x1, z1 } = room.rect;
          frame(new Box3(new Vector3(x0, floor.elevation, z0), new Vector3(x1, floor.elevation + 2.4, z1)), current, 40);
          lastFit.current = req;
          break;
        }
        case "employee": {
          const c = officeWorld.residents.get(req.employeeId)?.controller;
          if (!c || !c.visible) return;
          frame(new Box3(new Vector3(c.x - 2.2, c.elevation, c.z - 2.2), new Vector3(c.x + 2.2, c.elevation + 1.8, c.z + 2.2)), current, 40);
          lastFit.current = req;
          break;
        }
        case "screen": {
          // Look over the employee's shoulder at their desk monitor(s).
          const employee = useEmployeeStore.getState().employees.find((e) => e.id === req.employeeId);
          const ws = employee?.desk_id ? WORKSTATIONS.find((w) => w.id === employee.desk_id) : undefined;
          if (!ws) return;
          const floor = FLOOR_BY_ID.get(ws.floor)!;
          const depth = ws.style === "executive" ? -0.3 : ws.style === "reception" ? 0.05 : -0.22;
          const cx = ws.x + Math.sin(ws.rot) * depth;
          const cz = ws.z + Math.cos(ws.rot) * depth;
          const half = ws.monitors === 2 ? 0.68 : 0.36;
          const y = floor.elevation + MONITOR_SCREEN.y;
          const polar = 0.82;
          const box = new Box3(new Vector3(cx - half, y - 0.22, cz - half), new Vector3(cx + half, y + 0.22, cz + half));
          const fit = fitBox(box, orientationFor(ws.rot, polar), viewport, insets, 12);
          controls.maxZoom = Math.max(controls.maxZoom, fit.zoom);
          void controls.rotateTo(ws.rot, polar, animate);
          void controls.moveTo(fit.target.x, fit.target.y, fit.target.z, animate);
          void controls.zoomTo(fit.zoom, animate);
          lastFit.current = req;
          break;
        }
        case "zoom":
          void controls.zoomTo(camera.zoom * req.factor, animate);
          break;
        case "rotate":
          void controls.rotate(req.angle, 0, animate);
          break;
      }
      invalidate();
    },
    [size.width, size.height, camera, invalidate],
  );

  // Configure controls once: map-style pan on left drag, orbit on right drag.
  useEffect(() => {
    const c = controlsRef.current;
    if (!c) return;
    // Map-style pan: horizontal drag trucks, vertical drag moves along the ground.
    c.mouseButtons.left = ACTION.SCREEN_PAN;
    c.mouseButtons.right = ACTION.ROTATE;
    c.mouseButtons.middle = ACTION.ZOOM;
    c.mouseButtons.wheel = ACTION.ZOOM;
    c.touches.one = ACTION.TOUCH_SCREEN_PAN;
    c.touches.two = ACTION.TOUCH_ZOOM_ROTATE;
    c.touches.three = ACTION.TOUCH_ZOOM_TRUCK;
    c.dollyToCursor = true;
    c.minPolarAngle = MIN_POLAR;
    c.maxPolarAngle = MAX_POLAR;
    c.smoothTime = 0.32;
    c.draggingSmoothTime = 0.1;
    c.setBoundary(PAN_BOUNDARY);
    const markManual = () => {
      lastFit.current = null;
    };
    c.addEventListener("controlstart", markManual);
    return () => c.removeEventListener("controlstart", markManual);
  }, []);

  // Initial framing and re-framing on resize (unless the user has moved the camera).
  useEffect(() => {
    if (size.width === 0 || size.height === 0) return;
    if (lastFit.current) run(lastFit.current, false);
  }, [size.width, size.height, run]);

  useEffect(() => {
    if (request) run(request, true);
  }, [request, run]);

  // Keyboard navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const c = controlsRef.current;
      if (!c) return;
      const store = useOfficeStore.getState();
      const step = 80 / camera.zoom;
      switch (e.key) {
        case "ArrowLeft":
        case "a":
          void c.truck(-step, 0, true);
          break;
        case "ArrowRight":
        case "d":
          void c.truck(step, 0, true);
          break;
        case "ArrowUp":
        case "w":
          void c.forward(step, true);
          break;
        case "ArrowDown":
        case "s":
          void c.forward(-step, true);
          break;
        case "q":
          store.rotateBy(Math.PI / 8);
          return;
        case "e":
          store.rotateBy(-Math.PI / 8);
          return;
        case "+":
        case "=":
          store.zoomBy(1.25);
          return;
        case "-":
        case "_":
          store.zoomBy(0.8);
          return;
        case "0":
        case "Home":
          store.resetView();
          return;
        case "Escape":
          store.selectRoom(null);
          store.selectEmployee(null);
          return;
        default:
          return;
      }
      e.preventDefault();
      lastFit.current = null;
      invalidate();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [camera, invalidate]);

  // Read-only hook for end-to-end tests and diagnostics.
  useEffect(() => {
    window.__NEXUS_OFFICE__ = {
      state: () => {
        const s = useOfficeStore.getState();
        return { activeFloor: s.activeFloor, selectedRoomId: s.selectedRoomId, view: s.view, quality: s.quality };
      },
      camera: () => {
        const c = controlsRef.current;
        const target = c ? c.getTarget(new Vector3()) : new Vector3();
        return { zoom: camera.zoom, azimuth: c?.azimuthAngle ?? 0, polar: c?.polarAngle ?? 0, target: target.toArray(), overviewZoom: overviewZoom.current };
      },
      /** Screen position (CSS px, relative to the canvas) of a room's floor centre. */
      employees: () =>
        [...officeWorld.residents.values()].map((r) => ({
          id: r.employee.id,
          name: r.employee.name,
          status: r.employee.status,
          mode: r.controller.mode,
          doing: r.controller.doing,
          floor: r.controller.floor,
          visible: r.controller.visible,
        })),
      projectEmployee: (id: string) => {
        const c = officeWorld.residents.get(id)?.controller;
        if (!c || !c.visible) return null;
        const p = new Vector3(c.x, c.elevation + 0.9, c.z).project(camera);
        return { x: ((p.x + 1) / 2) * size.width, y: ((1 - p.y) / 2) * size.height };
      },
      projectRoom: (id: string) => {
        const room = ROOM_BY_ID.get(id);
        if (!room) return null;
        const floor = FLOOR_BY_ID.get(room.floor)!;
        const p = new Vector3((room.rect.x0 + room.rect.x1) / 2, floor.elevation, (room.rect.z0 + room.rect.z1) / 2).project(camera);
        return { x: ((p.x + 1) / 2) * size.width, y: ((1 - p.y) / 2) * size.height };
      },
      /** What each desk monitor shows (real work, drawn by DeskScreens). */
      screens: () => [...drawnScreens.values()],
      actions: {
        selectRoom: (id: string | null) => useOfficeStore.getState().selectRoom(id),
        selectEmployee: (id: string | null) => useOfficeStore.getState().selectEmployee(id),
        viewScreen: (id: string) => useOfficeStore.getState().viewScreen(id),
        setActiveFloor: (f: "all" | "L1" | "L2") => useOfficeStore.getState().setActiveFloor(f),
        resetView: () => useOfficeStore.getState().resetView(),
      },
    };
    return () => {
      delete window.__NEXUS_OFFICE__;
    };
  }, [camera, size.width, size.height]);

  return <CameraControls ref={controlsRef} makeDefault regress />;
}
