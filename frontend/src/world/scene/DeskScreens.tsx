"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { CanvasTexture, type Matrix4, type Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, SRGBColorSpace, Vector3 } from "three";

import type { Employee } from "@/lib/employees";
import type { Screen } from "@/lib/screens";

import { MONITOR_SCREEN } from "../geometry/furniture";
import type { Workstation } from "../layout/types";
import { drawMonitor, SCREEN_H, SCREEN_W } from "../screens/draw";
import { monitorView, viewKey } from "../screens/model";
import { useEmployeeStore } from "../state/employeeStore";
import { useScreenStore } from "../state/screenStore";
import { lockScreenTexture } from "../textures";

export interface DeskMonitor {
  key: string;
  ws: Workstation;
  index: number;
  matrix: Matrix4;
}

const noRaycast = () => null;

/** What each monitor currently shows (read by the e2e/diagnostics hook). */
export const drawnScreens = new Map<string, { desk: string; index: number; employeeId: string | null; app: string; mode: string; heading: string; status: string; body: string }>();

let shared: { geometry: PlaneGeometry; lock: MeshBasicMaterial } | null = null;
function sharedAssets() {
  if (!shared) {
    const { texture, redraw } = lockScreenTexture();
    const lock = new MeshBasicMaterial({ map: texture, toneMapped: false });
    lock.color.setScalar(0.95);
    shared = { geometry: new PlaneGeometry(MONITOR_SCREEN.width, MONITOR_SCREEN.height), lock };
    void document.fonts?.ready.then(() => redraw());
  }
  return shared;
}

interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: CanvasTexture;
  material: MeshBasicMaterial;
}

function createSurface(): Surface {
  const canvas = document.createElement("canvas");
  canvas.width = SCREEN_W;
  canvas.height = SCREEN_H;
  const ctx = canvas.getContext("2d")!;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new MeshBasicMaterial({ map: texture, toneMapped: false });
  material.color.setScalar(0.95);
  return { canvas, ctx, texture, material };
}

function useFontsReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void (document.fonts?.ready ?? Promise.resolve()).then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, []);
  return ready;
}

function DeskScreen({ monitor, employee, screen, fonts }: { monitor: DeskMonitor; employee: Employee | undefined; screen: Screen | undefined; fonts: boolean }) {
  const mesh = useRef<Mesh>(null);
  const surface = useRef<Surface | null>(null);
  const invalidate = useThree((s) => s.invalidate);
  const { geometry, lock } = sharedAssets();
  const view = employee ? monitorView(employee, screen ?? null, monitor.index, monitor.ws.monitors) : null;
  const key = view ? `${viewKey(view)}|${fonts}` : "lock";
  const { position, quaternion } = useMemo(() => {
    const p = new Vector3();
    const q = new Quaternion();
    monitor.matrix.decompose(p, q, new Vector3());
    return { position: p, quaternion: q };
  }, [monitor.matrix]);

  useEffect(() => {
    const m = mesh.current;
    if (!m) return;
    if (!view) {
      m.material = lock;
      drawnScreens.set(monitor.key, { desk: monitor.ws.id, index: monitor.index, employeeId: null, app: "lock", mode: "lock", heading: "", status: "", body: "" });
    } else {
      surface.current ??= createSurface();
      const s = surface.current;
      drawMonitor(s.ctx, view);
      s.texture.needsUpdate = true;
      m.material = s.material;
      drawnScreens.set(monitor.key, {
        desk: monitor.ws.id,
        index: monitor.index,
        employeeId: employee?.id ?? null,
        app: view.app,
        mode: view.mode,
        heading: view.heading,
        status: view.status,
        body: view.body.slice(-400),
      });
    }
    invalidate();
    // `key` captures everything that changes what is drawn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(
    () => () => {
      surface.current?.texture.dispose();
      surface.current?.material.dispose();
      surface.current = null;
      drawnScreens.delete(monitor.key);
    },
    [monitor.key],
  );

  return <mesh ref={mesh} name={`screen-${monitor.key}`} geometry={geometry} material={lock} position={position} quaternion={quaternion} raycast={noRaycast} />;
}

/** Desk monitors: role-styled screens showing each employee's real current work. */
export function DeskScreens({ monitors }: { monitors: DeskMonitor[] }) {
  const employees = useEmployeeStore((s) => s.employees);
  const screens = useScreenStore((s) => s.screens);
  const fonts = useFontsReady();
  const byDesk = useMemo(() => new Map(employees.filter((e) => e.desk_id).map((e) => [e.desk_id!, e])), [employees]);
  return (
    <group name="desk-screens">
      {monitors.map((m) => {
        const employee = byDesk.get(m.ws.id);
        return <DeskScreen key={m.key} monitor={m} employee={employee} screen={employee ? screens[employee.id] : undefined} fonts={fonts} />;
      })}
    </group>
  );
}
