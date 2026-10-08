"use client";

import { Environment, Lightformer, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { Color, type Group, type Mesh, MeshLambertMaterial, NeutralToneMapping, Vector3 } from "three";

import { generateAppearance } from "../characters/appearance";
import { PART_SPECS, partGeometry, tintColor } from "../characters/parts";
import { activityPose, jointMatrices, walkPose } from "../characters/rig";
import type { Activity } from "../characters/status";
import { furnitureGeometry } from "../geometry/furniture";
import { finishMaterials, FINISHES } from "../materials";
import { ScreenAnchors, ScreenLabel } from "../scene/screenAnchors";

export interface StudioSlot {
  label: string;
  activity: Activity | "walk";
  seated: boolean;
  seed: number;
  department: string;
}

const SPACING = 2.6;
const buildScale = new Vector3();

function Prop({ type, position, rotation = 0 }: { type: "desk" | "chair"; position: [number, number, number]; rotation?: number }) {
  const parts = furnitureGeometry(type);
  const materials = finishMaterials();
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {FINISHES.filter((f) => parts[f]).map((f) => (
        <mesh key={f} geometry={parts[f]} material={materials[f]} castShadow receiveShadow />
      ))}
    </group>
  );
}

function Person({ slot, x, z }: { slot: StudioSlot; x: number; z: number }) {
  const appearance = useMemo(() => generateAppearance(slot.seed, slot.department), [slot.seed, slot.department]);
  const parts = useMemo(
    () =>
      PART_SPECS.filter((p) => p.uses(appearance))
        .map((spec) => ({ spec, geometry: partGeometry(spec), material: new MeshLambertMaterial({ color: new Color(tintColor(appearance, spec.tint)), vertexColors: true }) }))
        .filter((p) => p.geometry),
    [appearance],
  );
  const refs = useRef<(Mesh | null)[]>([]);
  const root = useRef<Group>(null);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const walking = slot.activity === "walk";
    const pose = slot.activity === "walk" ? walkPose(t * 6) : activityPose(slot.activity, t, slot.seed);
    // Walkers circle their spot; everyone else stays put (seated facing the desk at -z).
    const angle = t * 0.6;
    const px = walking ? x + Math.cos(angle) * 0.7 : x;
    const pz = walking ? z + Math.sin(angle) * 0.7 : z;
    // Everyone faces the viewer, who looks from the -z side (seated people face their desks there).
    const yaw = walking ? -angle : Math.PI;
    const joints = jointMatrices(pose, px, 0, pz, yaw, appearance.height, appearance.build);
    parts.forEach(({ spec }, i) => {
      const mesh = refs.current[i];
      if (!mesh) return;
      mesh.matrix.copy(joints[spec.joint]);
      if (spec.widthByBuild) mesh.matrix.scale(buildScale.set(appearance.build, 1, 1));
    });
  });

  return (
    <group ref={root}>
      {parts.map(({ spec, geometry, material }, i) => (
        <mesh
          key={spec.key}
          ref={(m) => {
            refs.current[i] = m;
          }}
          geometry={geometry!}
          material={material}
          matrixAutoUpdate={false}
          castShadow
        />
      ))}
    </group>
  );
}

export default function StudioCanvas({ slots }: { slots: StudioSlot[] }) {
  const cols = Math.min(5, slots.length);
  return (
    <div className="relative h-full w-full">
      <Canvas
        shadows="percentage"
        camera={{ position: [(cols - 1) * SPACING * 0.5 + 5, 8.5, -11], fov: 38 }}
        gl={{ toneMapping: NeutralToneMapping }}
        dpr={[1, 1.5]}
      >
        <hemisphereLight args={["#c9d4ff", "#1a2044", 1.1]} />
        <directionalLight position={[-6, 10, -8]} intensity={2.6} castShadow shadow-mapSize={[1024, 1024]} />
        <Environment resolution={64} frames={1}>
          <Lightformer form="rect" intensity={1.5} position={[0, 8, 0]} rotation-x={Math.PI / 2} scale={[20, 20, 1]} />
        </Environment>
        <mesh rotation-x={-Math.PI / 2} receiveShadow position={[(cols - 1) * SPACING * 0.5, 0, SPACING * 0.5]}>
          <planeGeometry args={[cols * SPACING + 2, Math.ceil(slots.length / cols) * SPACING + 2]} />
          <meshStandardMaterial color="#3b4573" roughness={0.9} />
        </mesh>
        {slots.map((slot, i) => {
          const x = (i % cols) * SPACING;
          const z = Math.floor(i / cols) * SPACING;
          return (
            // Keyed by position so people stay mounted when they are regenerated.
            <group key={i}>
              {slot.seated && (
                <>
                  {/* Desk in front (toward -z); the chair faces it. */}
                  <Prop type="desk" position={[x, 0, z - 0.78]} rotation={0} />
                  <Prop type="chair" position={[x, 0, z]} rotation={Math.PI} />
                </>
              )}
              <Person slot={slot} x={x} z={z} />
            </group>
          );
        })}
        <OrbitControls target={[(cols - 1) * SPACING * 0.5, 0.5, SPACING * 0.3]} enableDamping maxPolarAngle={1.35} />
        <ScreenAnchors layer="studio" />
      </Canvas>
      {/* Name labels: page elements positioned over the 3D view (see scene/screenAnchors.tsx). */}
      <div className="pointer-events-none absolute inset-0 isolate overflow-hidden">
        {slots.map((slot, i) => (
          <ScreenLabel key={i} layer="studio" point={[(i % cols) * SPACING, slot.activity === "celebrate" ? 2.45 : 2.05, Math.floor(i / cols) * SPACING]}>
            <span className="rounded-full bg-nx-bg/80 px-2.5 py-1 text-[11px] font-medium whitespace-nowrap text-nx-text ring-1 ring-white/10">{slot.label}</span>
          </ScreenLabel>
        ))}
      </div>
    </div>
  );
}
