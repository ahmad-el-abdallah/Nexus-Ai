"use client";

import { Canvas } from "@react-three/fiber";
import { useEffect, useState } from "react";
import { NeutralToneMapping } from "three";

import { OfficeScene } from "./scene/OfficeScene";
import { requestShadowUpdate } from "./scene/runtime";
import { useOfficeStore } from "./state/officeStore";

/** The 3D headquarters. Loaded client-side only (WebGL). */
export default function OfficeCanvas() {
  const quality = useOfficeStore((s) => s.quality);
  const setWebGL = useOfficeStore((s) => s.setWebGL);
  const [bench] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("bench"));

  useEffect(() => requestShadowUpdate(), [quality]);

  const shadows = quality !== "low";
  return (
    <Canvas
      // Shadow support is fixed when the renderer is created, so remount on change.
      key={shadows ? "shadows" : "flat"}
      orthographic
      frameloop={bench ? "always" : "demand"}
      shadows={shadows ? "percentage" : false}
      dpr={quality === "high" ? [1, 2] : quality === "balanced" ? [1, 1.5] : 1}
      performance={{ min: 0.6, max: 1, debounce: 250 }}
      gl={{ antialias: quality !== "high", powerPreference: "high-performance", toneMapping: NeutralToneMapping, toneMappingExposure: 1.05 }}
      camera={{ position: [60, 60, 60], zoom: 18, near: -400, far: 800 }}
      onCreated={({ gl }) => {
        gl.shadowMap.autoUpdate = false;
        requestShadowUpdate();
        setWebGL("supported");
        const canvas = gl.domElement;
        canvas.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          // R3F also forces a context loss when the canvas unmounts (e.g. switching
          // to the 2D plan); only a loss on a canvas still on the page is a failure.
          window.setTimeout(() => {
            if (canvas.isConnected) setWebGL("lost");
          }, 0);
        });
      }}
      style={{ touchAction: "none" }}
      aria-label="3D view of the NEXUS AI headquarters"
    >
      <OfficeScene bench={bench} />
    </Canvas>
  );
}
