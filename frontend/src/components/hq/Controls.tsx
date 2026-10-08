"use client";

import { useEffect, useState } from "react";

import { FLOORS } from "@/world/layout/building";
import type { ActiveFloor } from "@/world/layout/types";
import { perfStats } from "@/world/scene/runtime";
import { type Quality, useOfficeStore } from "@/world/state/officeStore";

const btn =
  "grid size-10 place-items-center rounded-xl text-sm font-medium transition ring-1 backdrop-blur-md disabled:opacity-40";
const idle = "bg-nx-bg/70 text-nx-muted ring-nx-line-strong hover:bg-white/[0.07] hover:text-nx-text";
const on = "bg-gradient-to-br from-nx-violet/40 to-nx-cyan/25 text-white ring-nx-violet/60";

/** Elevator-style floor selector. */
export function FloorStack() {
  const active = useOfficeStore((s) => s.activeFloor);
  const setActiveFloor = useOfficeStore((s) => s.setActiveFloor);
  const options: Array<{ id: ActiveFloor; label: string; title: string }> = [
    { id: "all", label: "All", title: "All floors (overview)" },
    ...FLOORS.slice()
      .reverse()
      .map((f) => ({ id: f.id as ActiveFloor, label: String(f.level === 1 ? "G" : f.level), title: f.name })),
  ];
  return (
    <nav aria-label="Floors" className="glass-solid pointer-events-auto flex w-fit gap-1.5 p-1.5 md:flex-col">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          title={o.title}
          aria-label={o.title}
          aria-pressed={active === o.id}
          onClick={() => setActiveFloor(o.id)}
          className={`${btn} ${active === o.id ? on : idle} ${o.id === "all" ? "text-xs" : "font-mono"}`}
        >
          {o.label}
        </button>
      ))}
    </nav>
  );
}

export function CameraButtons() {
  const view = useOfficeStore((s) => s.view);
  const resetView = useOfficeStore((s) => s.resetView);
  const zoomBy = useOfficeStore((s) => s.zoomBy);
  const rotateBy = useOfficeStore((s) => s.rotateBy);
  const showPerf = useOfficeStore((s) => s.showPerf);
  const togglePerf = useOfficeStore((s) => s.togglePerf);
  const ambient = useOfficeStore((s) => s.ambient);
  const setAmbient = useOfficeStore((s) => s.setAmbient);
  const is3d = view === "3d";
  return (
    <div className="pointer-events-auto flex items-center gap-1.5">
      <button
        type="button"
        onClick={resetView}
        className={`flex h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-medium ring-1 backdrop-blur-md transition ${idle}`}
        aria-label="Return to headquarters overview"
      >
        <span aria-hidden>⌂</span>
        <span className="hidden sm:inline">Headquarters</span>
      </button>
      {is3d && (
        <>
          <button type="button" onClick={() => zoomBy(1.25)} className={`${btn} ${idle}`} aria-label="Zoom in">+</button>
          <button type="button" onClick={() => zoomBy(0.8)} className={`${btn} ${idle}`} aria-label="Zoom out">−</button>
          <button type="button" onClick={() => rotateBy(Math.PI / 8)} className={`${btn} ${idle}`} aria-label="Rotate left">⟲</button>
          <button type="button" onClick={() => rotateBy(-Math.PI / 8)} className={`${btn} ${idle}`} aria-label="Rotate right">⟳</button>
          <button
            type="button"
            onClick={() => setAmbient(!ambient)}
            aria-pressed={ambient}
            title="Decorative motion: idle breathing and coffee breaks. It never changes anyone's real status."
            className={`${btn} ${ambient ? on : idle} hidden w-auto px-3 text-xs sm:grid`}
          >
            Ambient {ambient ? "on" : "off"}
          </button>
          <button
            type="button"
            onClick={togglePerf}
            aria-pressed={showPerf}
            className={`${btn} ${showPerf ? on : idle} hidden w-auto px-3 text-xs sm:grid`}
            aria-label="Show rendering statistics"
          >
            Stats
          </button>
        </>
      )}
    </div>
  );
}

export function ViewToggle() {
  const view = useOfficeStore((s) => s.view);
  const webgl = useOfficeStore((s) => s.webgl);
  const setView = useOfficeStore((s) => s.setView);
  const noGL = webgl === "unsupported" || webgl === "lost";
  return (
    <div role="group" aria-label="View" className="flex rounded-xl bg-nx-bg/70 p-1 ring-1 ring-nx-line-strong backdrop-blur-md">
      {(["3d", "2d"] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          disabled={v === "3d" && noGL}
          title={v === "3d" && noGL ? "3D needs WebGL2, which this browser doesn't provide" : undefined}
          onClick={() => setView(v)}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold uppercase transition disabled:opacity-40 ${view === v ? "bg-white/10 text-white" : "text-nx-muted hover:text-nx-text"}`}
        >
          {v === "3d" ? "3D" : "2D plan"}
        </button>
      ))}
    </div>
  );
}

const QUALITY_LABEL: Record<Quality, string> = { high: "High", balanced: "Balanced", low: "Low" };

export function QualitySelect() {
  const quality = useOfficeStore((s) => s.quality);
  const setQuality = useOfficeStore((s) => s.setQuality);
  const view = useOfficeStore((s) => s.view);
  if (view !== "3d") return null;
  return (
    <label className="hidden items-center gap-2 text-xs text-nx-muted lg:flex">
      Quality
      <select
        value={quality}
        onChange={(e) => setQuality(e.target.value as Quality)}
        className="h-9 rounded-lg bg-nx-bg/70 px-2 text-xs text-nx-text ring-1 ring-nx-line-strong backdrop-blur-md focus:outline-none"
      >
        {(Object.keys(QUALITY_LABEL) as Quality[]).map((q) => (
          <option key={q} value={q}>
            {QUALITY_LABEL[q]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Live renderer counters (real values from the WebGL renderer). */
export function PerfOverlay() {
  const show = useOfficeStore((s) => s.showPerf && s.view === "3d");
  const [, tick] = useState(0);
  useEffect(() => {
    if (!show) return;
    const t = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [show]);
  if (!show) return null;
  const rows: Array<[string, string]> = [
    ["Draw calls", String(perfStats.drawCalls)],
    ["Triangles", perfStats.triangles.toLocaleString()],
    ["Geometries", String(perfStats.geometries)],
    ["Textures", String(perfStats.textures)],
    ["Shaders", String(perfStats.programs)],
    ["Last frame", perfStats.lastFrameMs === null ? "—" : `${perfStats.lastFrameMs.toFixed(1)} ms`],
    ["Frames drawn", String(perfStats.frames)],
    ["Resolution", `${perfStats.width}×${perfStats.height} @${perfStats.dpr}x`],
  ];
  return (
    <section aria-label="Rendering statistics" data-testid="perf-overlay" className="glass-solid pointer-events-auto w-64 p-4 font-mono text-[11px]">
      <p className="mb-2 font-sans text-xs font-semibold text-nx-text">Rendering</p>
      <dl className="space-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-nx-faint">{k}</dt>
            <dd className="text-nx-text">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 break-words text-nx-faint">{perfStats.renderer ?? "renderer unknown"}</p>
      <p className="mt-2 font-sans text-nx-faint">Frames render on demand, only when something changes.</p>
    </section>
  );
}
