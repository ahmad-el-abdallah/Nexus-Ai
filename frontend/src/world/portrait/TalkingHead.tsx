"use client";

/**
 * A close-up of an employee's own 3D character for face-to-face voice sessions:
 * the mouth opens and closes with the loudness of the voice actually playing,
 * the eyes blink, and the head nods while talking, tilts while listening and
 * looks up while thinking. One small canvas, rendered only while it is shown.
 */

import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { Color, type Mesh, MeshLambertMaterial, Matrix4, Vector3 } from "three";

import type { Employee } from "@/lib/employees";

import { PartsBuilder } from "../geometry/PartsBuilder";
import { generateAppearance } from "../characters/appearance";
import { PART_SPECS, partGeometry, tintColor } from "../characters/parts";
import { activityPose, jointMatrices } from "../characters/rig";

export type FaceMode = "speaking" | "listening" | "thinking" | "idle";

const EYE_Y = 0.17;
const EYE_Z = 0.1;
const MOUTH: [number, number, number] = [0, 0.105, 0.108];

function faceGeometry() {
  const eyes = new PartsBuilder();
  for (const s of [-1, 1]) eyes.sphere(0.014, { position: [s * 0.04, EYE_Y, EYE_Z], color: "#1a1c26", segments: 8 });
  const brows = new PartsBuilder();
  for (const s of [-1, 1]) brows.box([0.035, 0.007, 0.01], { position: [s * 0.04, 0.2, 0.104], rotation: [0, 0, s * -0.1], color: "#3b2a24" });
  // The mouth: a dark opening framed by lips, scaled open with the voice.
  const mouth = new PartsBuilder()
    .sphere(0.024, { position: MOUTH, scale: [1, 0.55, 0.35], color: "#3a1418", segments: 12 })
    .box([0.05, 0.006, 0.008], { position: [MOUTH[0], MOUTH[1] + 0.012, MOUTH[2] + 0.003], color: "#9b4f4f", radius: 0.003 })
    .box([0.046, 0.006, 0.008], { position: [MOUTH[0], MOUTH[1] - 0.012, MOUTH[2] + 0.003], color: "#9b4f4f", radius: 0.003 });
  return { eyes: eyes.build().matte!, brows: brows.build().matte!, mouth: mouth.build().matte! };
}

const around = (out: Matrix4, base: Matrix4, center: Vector3, sx: number, sy: number) =>
  out
    .copy(base)
    .multiply(new Matrix4().makeTranslation(center.x, center.y, center.z))
    .multiply(new Matrix4().makeScale(sx, sy, 1))
    .multiply(new Matrix4().makeTranslation(-center.x, -center.y, -center.z));

function Head({ employee, mode, level }: { employee: Employee; mode: FaceMode; level: () => number }) {
  const appearance = useMemo(() => generateAppearance(employee.avatar_seed, employee.department, undefined, employee.gender), [employee.avatar_seed, employee.department, employee.gender]);
  const parts = useMemo(
    () =>
      // Own animated face; no office headset (its band crosses the face in close-up).
      PART_SPECS.filter((p) => p.key !== "face" && p.key !== "headset" && p.uses(appearance))
        .map((spec) => ({ spec, geometry: partGeometry(spec), material: new MeshLambertMaterial({ color: new Color(tintColor(appearance, spec.tint)), vertexColors: true }) }))
        .filter((p) => p.geometry),
    [appearance],
  );
  const face = useMemo(() => faceGeometry(), []);
  const faceMaterial = useMemo(() => new MeshLambertMaterial({ vertexColors: true }), []);
  const refs = useRef<(Mesh | null)[]>([]);
  const eyes = useRef<Mesh>(null);
  const brows = useRef<Mesh>(null);
  const mouth = useRef<Mesh>(null);
  const open = useRef(0);
  const nextBlink = useRef(1.5);
  const seed = employee.avatar_seed % 1000;

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const pose = activityPose("standIdle", t, seed);
    const voice = mode === "speaking" ? level() : 0;
    open.current += (voice - open.current) * 0.45;
    pose.neckYaw *= 0.25; // mostly facing you
    if (mode === "speaking") {
      pose.neckPitch = 0.03 + open.current * 0.07 + Math.sin(t * 2.3) * 0.02;
      pose.neckYaw += Math.sin(t * 0.9) * 0.05;
    } else if (mode === "listening") {
      pose.neckPitch = 0.06;
      pose.spineRoll = 0.04;
    } else if (mode === "thinking") {
      pose.neckPitch = -0.12;
      pose.neckYaw = 0.22;
    }
    const joints = jointMatrices(pose, 0, 0, 0, 0, appearance.height, appearance.build);
    parts.forEach(({ spec }, i) => {
      const mesh = refs.current[i];
      if (!mesh) return;
      mesh.matrix.copy(joints[spec.joint]);
      if (spec.widthByBuild) mesh.matrix.scale(new Vector3(appearance.build, 1, 1));
    });
    // Blink every few seconds.
    if (t > nextBlink.current + 0.14) nextBlink.current = t + 2 + Math.random() * 3;
    const blink = t > nextBlink.current ? 0.1 : 1;
    if (eyes.current) around(eyes.current.matrix, joints.head, new Vector3(0, EYE_Y, EYE_Z), 1, blink);
    if (brows.current) brows.current.matrix.copy(joints.head).multiply(new Matrix4().makeTranslation(0, mode === "thinking" ? 0.006 : open.current * 0.004, 0));
    if (mouth.current) around(mouth.current.matrix, joints.head, new Vector3(...MOUTH), 1 + open.current * 0.15, 0.22 + open.current * 1.5);
  });

  return (
    <group>
      {parts.map(({ spec, geometry, material }, i) => (
        <mesh
          key={spec.key}
          ref={(m) => {
            refs.current[i] = m;
          }}
          geometry={geometry!}
          material={material}
          matrixAutoUpdate={false}
        />
      ))}
      <mesh ref={eyes} geometry={face.eyes} material={faceMaterial} matrixAutoUpdate={false} />
      <mesh ref={brows} geometry={face.brows} material={faceMaterial} matrixAutoUpdate={false} />
      <mesh ref={mouth} geometry={face.mouth} material={faceMaterial} matrixAutoUpdate={false} />
    </group>
  );
}

/** `wide`: full screen — head and shoulders from a little further away. */
export default function TalkingHead({ employee, mode, level, wide = false }: { employee: Employee; mode: FaceMode; level: () => number; wide?: boolean }) {
  // Eye level: hips (0.9) + spine (0.56) + the eyes on the head (~0.17), times height.
  const eye = 1.63 * (generateAppearance(employee.avatar_seed, employee.department, undefined, employee.gender).height || 1);
  return (
    <Canvas
      dpr={[1, wide ? 2 : 1.5]}
      camera={{ position: [0, eye + 0.02, wide ? 1.7 : 1.0], fov: 26 }}
      onCreated={({ camera }) => camera.lookAt(0, eye - (wide ? 0.12 : 0.07), 0)}
      gl={{ antialias: true, alpha: true }}
    >
      <ambientLight intensity={1.1} />
      <directionalLight position={[0.8, 2.4, 1.6]} intensity={1.6} />
      <directionalLight position={[-1.2, 1.6, 0.8]} intensity={0.5} color="#a5b4fc" />
      <Head employee={employee} mode={mode} level={level} />
    </Canvas>
  );
}
