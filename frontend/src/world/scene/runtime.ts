/**
 * Small module-level runtime shared by scene components: shadow map
 * invalidation (the shadow map is static and only re-rendered on change)
 * and performance counters read by the HUD, tests and the benchmark.
 */

let shadowsDirty = true;

export function requestShadowUpdate(): void {
  shadowsDirty = true;
}

export function consumeShadowUpdate(): boolean {
  const dirty = shadowsDirty;
  shadowsDirty = false;
  return dirty;
}

export interface PerfStats {
  renderer: string | null;
  frames: number;
  lastFrameMs: number | null;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  dpr: number;
  width: number;
  height: number;
  firstFrameMs: number | null;
}

export const perfStats: PerfStats = {
  renderer: null,
  frames: 0,
  lastFrameMs: null,
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  programs: 0,
  dpr: 1,
  width: 0,
  height: 0,
  firstFrameMs: null,
};

export interface BenchResult {
  done: boolean;
  quality: string;
  seconds: number;
  frames: number;
  avgFps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  worstMs: number;
  drawCalls: number;
  triangles: number;
  renderer: string | null;
  width: number;
  height: number;
  dpr: number;
}

declare global {
  interface Window {
    __NEXUS_PERF__?: PerfStats;
    __NEXUS_BENCH__?: BenchResult | { done: false };
    __NEXUS_OFFICE__?: unknown;
  }
}
