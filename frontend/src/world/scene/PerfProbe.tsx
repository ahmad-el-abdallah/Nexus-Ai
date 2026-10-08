"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";

import { perfStats } from "./runtime";

/**
 * Collects renderer counters per rendered frame. gl.info is reset manually
 * so multi-pass post-processing frames are counted in full.
 */
export function PerfProbe() {
  const gl = useThree((s) => s.gl);
  const last = useRef<number | null>(null);

  useEffect(() => {
    gl.info.autoReset = false;
    const ctx = gl.getContext();
    const ext = ctx.getExtension("WEBGL_debug_renderer_info");
    perfStats.renderer = String(ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER));
    window.__NEXUS_PERF__ = perfStats;
    return () => {
      gl.info.autoReset = true;
    };
  }, [gl]);

  useFrame((state) => {
    const now = performance.now();
    if (perfStats.firstFrameMs === null) perfStats.firstFrameMs = Math.round(now);
    perfStats.lastFrameMs = last.current === null ? null : now - last.current;
    last.current = now;
    perfStats.frames += 1;
    const { render, memory, programs } = gl.info;
    if (render.calls > 0) {
      perfStats.drawCalls = render.calls;
      perfStats.triangles = render.triangles;
    }
    perfStats.geometries = memory.geometries;
    perfStats.textures = memory.textures;
    perfStats.programs = programs?.length ?? 0;
    perfStats.dpr = state.viewport.dpr;
    perfStats.width = state.size.width;
    perfStats.height = state.size.height;
    gl.info.reset();
  }, -100);

  return null;
}
