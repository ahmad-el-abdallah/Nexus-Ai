"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";

import { useOfficeStore } from "../state/officeStore";
import { perfStats } from "./runtime";

const WARMUP_S = 2;
const MEASURE_S = 10;

interface Controls {
  rotate: (azimuth: number, polar: number, transition?: boolean) => Promise<void>;
}

/**
 * `?bench=1`: renders continuously while orbiting the building, then
 * publishes frame-time statistics on window.__NEXUS_BENCH__.
 */
export function Benchmark() {
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const start = useRef<number | null>(null);
  const samples = useRef<number[]>([]);
  const last = useRef<number | null>(null);
  const done = useRef(false);

  useFrame((_, dt) => {
    if (done.current) return;
    const now = performance.now();
    start.current ??= now;
    void controls?.rotate(dt * 0.6, 0, false);
    const elapsed = (now - start.current) / 1000;
    if (elapsed > WARMUP_S && last.current !== null) samples.current.push(now - last.current);
    last.current = now;
    if (elapsed < WARMUP_S + MEASURE_S) {
      window.__NEXUS_BENCH__ = { done: false };
      return;
    }
    done.current = true;
    const s = [...samples.current].sort((a, b) => a - b);
    const pct = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    const total = samples.current.reduce((a, b) => a + b, 0);
    window.__NEXUS_BENCH__ = {
      done: true,
      quality: useOfficeStore.getState().quality,
      seconds: MEASURE_S,
      frames: s.length,
      avgFps: Math.round((s.length / total) * 1000 * 10) / 10,
      p50Ms: Math.round(pct(0.5) * 100) / 100,
      p95Ms: Math.round(pct(0.95) * 100) / 100,
      p99Ms: Math.round(pct(0.99) * 100) / 100,
      worstMs: Math.round(s[s.length - 1] * 100) / 100,
      drawCalls: perfStats.drawCalls,
      triangles: perfStats.triangles,
      renderer: perfStats.renderer,
      width: perfStats.width,
      height: perfStats.height,
      dpr: perfStats.dpr,
    };
  });

  return null;
}
