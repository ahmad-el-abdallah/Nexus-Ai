"use client";

import { type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  AdditiveBlending,
  type BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  InstancedBufferAttribute,
  type InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  BoxGeometry,
  RingGeometry,
  Vector3,
  Sphere,
  type Mesh,
} from "three";

import { initials } from "../characters/appearance";
import { PART_SPECS, partGeometry, type PartSpec, tintColor } from "../characters/parts";
import { blendPose, createJointMatrices, jointMatrices, type JointMatrices, type Pose } from "../characters/rig";
import { STATUS_META } from "../characters/status";
import { officeWorld, type Resident } from "../characters/world";
import { isFloorVisible } from "../layout/queries";
import { useEmployeeStore } from "../state/employeeStore";
import { useOfficeStore } from "../state/officeStore";
import { fontFamily } from "../textures";
import { cameraInfo } from "./runtime";

const HIDDEN = new Matrix4().makeScale(0, 0, 0);
const orbColors = new Map<string, Color>();
/** Status light colour (boosted above 1 so it blooms), cached per status colour. */
function orbColor(hex: string): Color {
  let c = orbColors.get(hex);
  if (!c) orbColors.set(hex, (c = new Color(hex).multiplyScalar(1.8)));
  return c;
}
const BIG_SPHERE = new Sphere(new Vector3(0, 0, 0), 60);
const DEPARTMENT_COLORS: Record<string, string> = {
  executive: "#a78bfa",
  sales: "#fbbf24",
  marketing: "#f472b6",
  engineering: "#22d3ee",
};
/** Frame rate for gentle idle motion when nothing else is moving. */
const AMBIENT_FPS = 15;

const bodyMaterial = new MeshLambertMaterial({ vertexColors: true });

// ---------------------------------------------------------------------------
// Name tag atlas
// ---------------------------------------------------------------------------

const CELL_W = 512;
const CELL_H = 128;
const COLS = 4;

function drawNameAtlas(residents: Resident[]) {
  const rows = Math.max(1, Math.ceil(residents.length / COLS));
  const canvas = document.createElement("canvas");
  canvas.width = CELL_W * COLS;
  canvas.height = CELL_H * rows;
  const ctx = canvas.getContext("2d")!;
  const font = fontFamily();
  residents.forEach((r, i) => {
    const x = (i % COLS) * CELL_W;
    const y = Math.floor(i / COLS) * CELL_H;
    const accent = DEPARTMENT_COLORS[r.employee.department] ?? "#94a3b8";
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = "rgba(9, 13, 32, 0.88)";
    ctx.beginPath();
    ctx.roundRect(8, 14, CELL_W - 16, CELL_H - 28, 42);
    ctx.fill();
    ctx.strokeStyle = `${accent}aa`;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(58, CELL_H / 2, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0b1023";
    ctx.font = `700 24px ${font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initials(r.employee.name), 58, CELL_H / 2 + 1);
    ctx.textAlign = "left";
    ctx.fillStyle = "#eef1fb";
    ctx.font = `700 34px ${font}`;
    ctx.fillText(r.employee.name, 100, 50, CELL_W - 120);
    ctx.fillStyle = "#9aa3c7";
    ctx.font = `500 22px ${font}`;
    ctx.fillText(r.employee.role, 100, 84, CELL_W - 120);
    ctx.restore();
  });
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return { texture, rows };
}

const nameTagMaterial = () =>
  new ShaderMaterial({
    // Size in screen pixels: an orthographic camera maps 1 world unit to `zoom` px.
    uniforms: { uMap: { value: null }, uSize: { value: [176, 44] }, uInvZoom: { value: 0.05 } },
    vertexShader: /* glsl */ `
      attribute vec4 aCell;
      attribute float aAlpha;
      uniform vec2 uSize;
      uniform float uInvZoom;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vUv = mix(aCell.xy, aCell.zw, uv);
        vAlpha = aAlpha;
        vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        center.xy += position.xy * uSize * uInvZoom;
        gl_Position = projectionMatrix * center;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vec4 c = texture2D(uMap, vUv);
        if (c.a * vAlpha < 0.02) discard;
        gl_FragColor = vec4(c.rgb, c.a * vAlpha);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

interface PartBatch {
  spec: PartSpec;
  geometry: BufferGeometry;
  /** Resident index → instance index (−1 when the resident doesn't use the part). */
  slots: number[];
  count: number;
}

const _m = new Matrix4();
const _scaleBuild = new Matrix4();
const _v = new Vector3();

/** Every AI employee in the office, driven by the real roster and statuses. */
export function Characters() {
  const employees = useEmployeeStore((s) => s.employees);
  const invalidate = useThree((s) => s.invalidate);
  const camera = useThree((s) => s.camera);
  const selectEmployee = useOfficeStore((s) => s.selectEmployee);
  const hoverEmployee = useOfficeStore((s) => s.hoverEmployee);

  // Status updates flow into the existing controllers; the instancing layout
  // only changes when people or appearances change.
  const signature = useMemo(() => {
    officeWorld.sync(employees);
    return [...officeWorld.residents.values()].map((r) => `${r.employee.id}:${r.employee.avatar_seed}:${r.employee.department}`).join("|");
  }, [employees]);
  const residents = useMemo(
    () => (signature ? signature.split("|").map((key) => officeWorld.residents.get(key.split(":")[0])!) : []),
    [signature],
  );

  const batches = useMemo<PartBatch[]>(() => {
    const out: PartBatch[] = [];
    for (const spec of PART_SPECS) {
      const geometry = partGeometry(spec);
      if (!geometry) continue;
      let count = 0;
      const slots = residents.map((r) => (spec.uses(r.appearance) ? count++ : -1));
      if (count > 0) out.push({ spec, geometry, slots, count });
    }
    return out;
  }, [residents]);

  const partRefs = useRef<(InstancedMesh | null)[]>([]);
  const shadowRef = useRef<InstancedMesh>(null);
  const orbRef = useRef<InstancedMesh>(null);
  const hitRef = useRef<InstancedMesh>(null);
  const tagRef = useRef<InstancedMesh>(null);
  const ringRef = useRef<Mesh>(null);
  const poses = useRef(new Map<string, Pose>());
  const jointCache = useRef(new Map<string, JointMatrices>());
  const lastFrame = useRef<number | null>(null);
  const ambientTimer = useRef<number | null>(null);

  // Per-instance colours (appearance), set whenever the layout changes.
  useEffect(() => {
    batches.forEach((batch, b) => {
      const mesh = partRefs.current[b];
      if (!mesh) return;
      residents.forEach((r, i) => {
        const slot = batch.slots[i];
        if (slot >= 0) mesh.setColorAt(slot, new Color(tintColor(r.appearance, batch.spec.tint)));
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.boundingSphere = BIG_SPHERE;
    });
    for (const m of [shadowRef.current, orbRef.current, hitRef.current, tagRef.current]) if (m) m.boundingSphere = BIG_SPHERE;
    invalidate();
  }, [batches, residents, invalidate]);

  // Name tag atlas (redrawn when fonts load).
  const tags = useMemo(() => {
    const geometry = new PlaneGeometry(1, 1);
    const material = nameTagMaterial();
    const cells = new Float32Array(Math.max(1, residents.length) * 4);
    const alpha = new Float32Array(Math.max(1, residents.length));
    geometry.setAttribute("aCell", new InstancedBufferAttribute(cells, 4));
    geometry.setAttribute("aAlpha", new InstancedBufferAttribute(alpha, 1));
    const redraw = () => {
      const { texture, rows } = drawNameAtlas(residents);
      (material.uniforms.uMap.value as CanvasTexture | null)?.dispose();
      material.uniforms.uMap.value = texture;
      residents.forEach((_, i) => {
        const c = i % COLS;
        const r = Math.floor(i / COLS);
        cells.set([c / COLS, 1 - (r + 1) / rows, (c + 1) / COLS, 1 - r / rows], i * 4);
      });
      (geometry.getAttribute("aCell") as InstancedBufferAttribute).needsUpdate = true;
    };
    redraw();
    return { geometry, material, redraw };
  }, [residents]);

  useEffect(() => {
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (cancelled) return;
      tags.redraw();
      invalidate();
    });
    return () => {
      cancelled = true;
      (tags.material.uniforms.uMap.value as CanvasTexture | null)?.dispose();
      tags.material.dispose();
      tags.geometry.dispose();
    };
  }, [tags, invalidate]);

  // Re-render when statuses change (people may need to start walking).
  useEffect(() => invalidate(), [employees, invalidate]);

  useEffect(
    () => () => {
      if (ambientTimer.current) window.clearTimeout(ambientTimer.current);
    },
    [],
  );

  useFrame((state) => {
    const nowMs = performance.now();
    const dt = lastFrame.current === null ? 0 : Math.min(0.1, (nowMs - lastFrame.current) / 1000);
    lastFrame.current = nowMs;
    const t = state.clock.elapsedTime;
    const office = useOfficeStore.getState();
    officeWorld.update(dt, nowMs / 1000, office.ambient);

    const tagAlphaAttr = tags.geometry.getAttribute("aAlpha") as InstancedBufferAttribute;
    const zoomFactor = (camera as { zoom: number }).zoom / cameraInfo.overviewZoom;
    const tagBase = Math.min(1, Math.max(0, (zoomFactor - 1.8) / 0.6));
    tags.material.uniforms.uInvZoom.value = 1 / (camera as { zoom: number }).zoom;
    let ringTarget: Resident | null = null;

    residents.forEach((r, i) => {
      const c = r.controller;
      const shown = c.visible && isFloorVisible(c.floor, office.activeFloor);
      const target = c.pose(t, r.employee.status);
      const prev = poses.current.get(r.employee.id) ?? target;
      const k = 1 - Math.exp(-dt * (c.mode === "walking" ? 18 : 8));
      const pose = dt === 0 ? target : blendPose(prev, target, k);
      poses.current.set(r.employee.id, pose);

      // Fade in/out of the elevator by scaling (instances share one opaque material).
      const s = r.appearance.height * (0.25 + 0.75 * c.opacity);
      let reuse = jointCache.current.get(r.employee.id);
      if (!reuse) jointCache.current.set(r.employee.id, (reuse = createJointMatrices()));
      const joints = shown ? jointMatrices(pose, c.x, c.elevation, c.z, c.yaw, s, r.appearance.build, reuse) : null;

      batches.forEach((batch, b) => {
        const slot = batch.slots[i];
        const mesh = partRefs.current[b];
        if (slot < 0 || !mesh) return;
        if (!joints) return mesh.setMatrixAt(slot, HIDDEN);
        const m = joints[batch.spec.joint];
        if (batch.spec.widthByBuild) {
          _scaleBuild.makeScale(r.appearance.build, 1, 1);
          mesh.setMatrixAt(slot, _m.copy(m).multiply(_scaleBuild));
        } else mesh.setMatrixAt(slot, m);
      });

      const meta = STATUS_META[r.employee.status];
      if (joints) {
        const head = _v.setFromMatrixPosition(joints.head);
        shadowRef.current?.setMatrixAt(i, _m.makeScale(0.62 * s, 1, 0.62 * s).setPosition(c.x, c.elevation + 0.012, c.z));
        const pulse = r.employee.status === "assigned" || r.employee.status === "completed" ? 1 + Math.sin(t * 5) * 0.25 : 1;
        orbRef.current?.setMatrixAt(i, _m.makeScale(pulse, pulse, pulse).setPosition(head.x, head.y + 0.42 * s, head.z));
        orbRef.current?.setColorAt(i, orbColor(meta.color));
        hitRef.current?.setMatrixAt(i, _m.makeScale(s, s, s).setPosition(c.x, c.elevation + 0.9 * s, c.z));
        tagRef.current?.setMatrixAt(i, _m.makeTranslation(head.x, head.y + 0.62 * s, head.z));
      } else {
        for (const m of [shadowRef.current, orbRef.current, hitRef.current, tagRef.current]) m?.setMatrixAt(i, HIDDEN);
      }
      const focused = office.selectedEmployeeId === r.employee.id || office.hoveredEmployeeId === r.employee.id;
      tagAlphaAttr.setX(i, joints ? (focused ? 1 : tagBase) : 0);
      if (joints && office.selectedEmployeeId === r.employee.id) ringTarget = r;
      else if (joints && !ringTarget && office.hoveredEmployeeId === r.employee.id) ringTarget = r;
    });

    for (const mesh of [...partRefs.current, shadowRef.current, orbRef.current, hitRef.current, tagRef.current]) {
      if (!mesh) continue;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    tagAlphaAttr.needsUpdate = true;

    const ring = ringRef.current;
    if (ring) {
      const target = ringTarget as Resident | null;
      ring.visible = !!target;
      if (target) {
        ring.position.set(target.controller.x, target.controller.elevation + 0.02, target.controller.z);
        ring.scale.setScalar(1 + Math.sin(t * 3) * 0.06);
      }
    }

    // Frame scheduling: walking needs every frame; idle motion runs at a low rate.
    if (officeWorld.anyMoving) invalidate();
    else if ((office.ambient || ring?.visible) && residents.length > 0 && ambientTimer.current === null) {
      ambientTimer.current = window.setTimeout(() => {
        ambientTimer.current = null;
        invalidate();
      }, 1000 / AMBIENT_FPS);
    }
  });

  const pick = (e: ThreeEvent<PointerEvent | MouseEvent>) => (e.instanceId === undefined ? null : (residents[e.instanceId] ?? null));
  const count = Math.max(1, residents.length);

  return (
    <group name="characters">
      {batches.map((batch, b) => (
        <instancedMesh
          key={`${batch.spec.key}-${batch.count}-${signature.length}`}
          ref={(m) => {
            partRefs.current[b] = m;
          }}
          name={`character:${batch.spec.key}`}
          args={[batch.geometry, bodyMaterial, batch.count]}
          raycast={() => null}
          frustumCulled={false}
        />
      ))}
      <instancedMesh key={`shadow-${count}`} ref={shadowRef} args={[blobGeometry, blobMaterial, count]} raycast={() => null} frustumCulled={false} renderOrder={1} />
      <instancedMesh key={`orb-${count}`} ref={orbRef} args={[orbGeometry, orbMaterial, count]} raycast={() => null} frustumCulled={false} />
      <instancedMesh key={`tag-${count}-${signature.length}`} ref={tagRef} args={[tags.geometry, tags.material, count]} raycast={() => null} frustumCulled={false} renderOrder={10} />
      <instancedMesh
        key={`hit-${count}`}
        ref={hitRef}
        name="character-hitboxes"
        args={[hitGeometry, hitMaterial, count]}
        frustumCulled={false}
        onPointerMove={(e) => {
          const r = pick(e);
          if (!r) return;
          e.stopPropagation();
          hoverEmployee(r.employee.id);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          hoverEmployee(null);
          document.body.style.cursor = "";
        }}
        onClick={(e) => {
          const r = pick(e);
          if (!r || e.delta > 6) return;
          e.stopPropagation();
          selectEmployee(r.employee.id);
        }}
      />
      <mesh ref={ringRef} geometry={ringGeometry} material={ringMaterial} rotation={[-Math.PI / 2, 0, 0]} visible={false} raycast={() => null} />
    </group>
  );
}

// Shared lightweight meshes.
const blobGeometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const blobMaterial = new MeshBasicMaterial({
  color: "#000000",
  transparent: true,
  opacity: 0.35,
  depthWrite: false,
  alphaMap: (() => {
    if (typeof document === "undefined") return null;
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 31);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(1, "#000000");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new CanvasTexture(c);
  })(),
});
const orbGeometry = new SphereGeometry(0.055, 12, 8);
const orbMaterial = new MeshBasicMaterial({ toneMapped: false });
const hitGeometry = new BoxGeometry(0.7, 1.8, 0.7);
const hitMaterial = new MeshBasicMaterial({ visible: false });
const ringGeometry = new RingGeometry(0.42, 0.5, 40);
const ringMaterial = new MeshBasicMaterial({ color: new Color("#5ee8f5").multiplyScalar(2), toneMapped: false, side: DoubleSide, forceSinglePass: true, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false });
