"use client";

import { AdaptiveDpr, Environment, Lightformer } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, N8AO, ToneMapping } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DirectionalLight, Group } from "three";

import type { BuiltParts } from "../geometry/PartsBuilder";
import { buildElevator, buildPlinth, buildSlab } from "../geometry/site";
import { FLOORS } from "../layout/building";
import { isFloorVisible } from "../layout/queries";
import type { FloorDef } from "../layout/types";
import { castsShadow, FINISHES, finishMaterials, receivesShadow } from "../materials";
import { useOfficeStore } from "../state/officeStore";
import { Benchmark } from "./Benchmark";
import { Characters } from "./Characters";
import { CameraRig } from "./CameraRig";
import { Furniture } from "./Furniture";
import { PerfProbe } from "./PerfProbe";
import { Rooms } from "./Rooms";
import { ScreenAnchors } from "./screenAnchors";
import { consumeShadowUpdate, requestShadowUpdate } from "./runtime";
import { Walls } from "./Walls";

const noRaycast = () => null;

function Parts({ parts, name }: { parts: BuiltParts; name: string }) {
  const materials = finishMaterials();
  return (
    <>
      {FINISHES.filter((f) => parts[f]).map((f) => (
        <mesh key={f} name={`${name}:${f}`} geometry={parts[f]} material={materials[f]} castShadow={castsShadow(f)} receiveShadow={receivesShadow(f)} raycast={noRaycast} />
      ))}
    </>
  );
}

function Site() {
  const plinth = useMemo(() => buildPlinth(), []);
  const elevator = useMemo(() => buildElevator(), []);
  return (
    <group name="site">
      <Parts parts={plinth} name="plinth" />
      <Parts parts={elevator} name="elevator" />
    </group>
  );
}

/** One storey. Floors above the selection lift away and hide. */
function FloorLevel({ floor, children }: { floor: FloorDef; children: ReactNode }) {
  const visible = useOfficeStore((s) => isFloorVisible(floor.id, s.activeFloor));
  const ref = useRef<Group>(null);
  const progress = useRef(visible ? 1 : 0);
  const invalidate = useThree((s) => s.invalidate);
  const slab = useMemo(() => buildSlab(floor.id), [floor.id]);

  useEffect(() => invalidate(), [visible, invalidate]);

  useFrame((_, dt) => {
    const group = ref.current;
    const target = visible ? 1 : 0;
    if (!group || progress.current === target) return;
    const step = Math.min(dt, 0.05) * 2.6;
    progress.current = target > progress.current ? Math.min(1, progress.current + step) : Math.max(0, progress.current - step);
    const eased = 1 - Math.pow(1 - progress.current, 3);
    group.position.y = (1 - eased) * 9;
    group.visible = progress.current > 0.001;
    requestShadowUpdate();
    invalidate();
  });

  return (
    <group ref={ref} name={`floor-${floor.id}`} visible={visible}>
      <Parts parts={slab} name={`slab-${floor.id}`} />
      {children}
    </group>
  );
}

/** Re-renders the (otherwise static) shadow map only when something moved. */
function ShadowUpdater() {
  const gl = useThree((s) => s.gl);
  useFrame(() => {
    if (consumeShadowUpdate()) gl.shadowMap.needsUpdate = true;
  }, -50);
  return null;
}

function Lighting({ shadows }: { shadows: boolean }) {
  const sun = useRef<DirectionalLight>(null);
  // Nested shadow-camera props don't refresh the projection; do it explicitly.
  useLayoutEffect(() => {
    sun.current?.shadow.camera.updateProjectionMatrix();
    requestShadowUpdate();
  }, [shadows]);
  return (
    <>
      <hemisphereLight args={["#c9d4ff", "#1a2044", 1.05]} />
      <ambientLight intensity={0.12} />
      <directionalLight
        ref={sun}
        position={[-24, 34, 12]}
        intensity={3.1}
        color="#fff3e2"
        castShadow={shadows}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-28}
        shadow-camera-right={28}
        shadow-camera-top={26}
        shadow-camera-bottom={-26}
        shadow-camera-near={1}
        shadow-camera-far={90}
        shadow-radius={3}
        shadow-bias={-0.0004}
        shadow-normalBias={0.035}
      />
      <directionalLight position={[22, 16, -8]} intensity={0.5} color="#9db1ff" />
      <Environment resolution={128} frames={1}>
        <Lightformer form="rect" intensity={1.6} color="#d6ddff" position={[0, 12, 0]} rotation-x={Math.PI / 2} scale={[40, 40, 1]} />
        <Lightformer form="rect" intensity={2.2} color="#8b5cf6" position={[-18, 6, 12]} rotation-y={Math.PI / 3} scale={[14, 6, 1]} />
        <Lightformer form="rect" intensity={2.2} color="#22d3ee" position={[18, 6, -12]} rotation-y={-Math.PI / 1.5} scale={[14, 6, 1]} />
        <Lightformer form="ring" intensity={1.2} color="#ffffff" position={[10, 8, 16]} scale={6} />
      </Environment>
    </>
  );
}

function Effects() {
  const quality = useOfficeStore((s) => s.quality);
  if (quality === "low") return null;
  return (
    <EffectComposer multisampling={quality === "high" ? 4 : 2} enableNormalPass={false}>
      {[
        ...(quality === "high" ? [<N8AO key="ao" halfRes aoRadius={1.2} distanceFalloff={0.6} intensity={2.2} quality="performance" />] : []),
        <Bloom key="bloom" mipmapBlur levels={quality === "high" ? 8 : 5} luminanceThreshold={1} luminanceSmoothing={0.2} intensity={0.75} radius={0.65} />,
        // The composer disables renderer tone mapping, so apply it as the final effect.
        <ToneMapping key="tone" mode={ToneMappingMode.NEUTRAL} />,
      ]}
    </EffectComposer>
  );
}

export function OfficeScene({ bench }: { bench: boolean }) {
  const quality = useOfficeStore((s) => s.quality);
  // Diagnostic switch for benchmarking the building without people (`?people=off`).
  const [people] = useState(() => typeof window === "undefined" || new URLSearchParams(window.location.search).get("people") !== "off");
  return (
    <>
      <Lighting shadows={quality !== "low"} />
      <Site />
      {FLOORS.map((floor) => (
        <FloorLevel key={floor.id} floor={floor}>
          <Rooms floor={floor.id} />
          <Walls floor={floor.id} />
          <Furniture floor={floor.id} />
        </FloorLevel>
      ))}
      {people && <Characters />}
      <ScreenAnchors layer="office" />
      <CameraRig />
      {/* Lower the resolution only while the camera moves; still frames render at full DPR. */}
      <AdaptiveDpr />
      <ShadowUpdater />
      <Effects />
      <PerfProbe />
      {bench && <Benchmark />}
    </>
  );
}
