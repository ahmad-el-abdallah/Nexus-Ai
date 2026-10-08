"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect } from "react";

import { NexusMark } from "@/components/NexusMark";
import { StatusDot } from "@/components/StatusPill";
import { useSystemStatus } from "@/hooks/useSystemStatus";
import { detectWebGL } from "@/lib/webgl";
import { FloorPlan2D } from "@/world/plan2d/FloorPlan2D";
import { type Quality, useOfficeStore } from "@/world/state/officeStore";

import { CameraButtons, FloorStack, PerfOverlay, QualitySelect, ViewToggle } from "./Controls";
import { RoomFinder } from "./RoomFinder";
import { RoomPanel } from "./RoomPanel";

const OfficeCanvas = dynamic(() => import("@/world/OfficeCanvas"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 grid place-items-center text-sm text-nx-muted" role="status">
      <div className="flex flex-col items-center gap-3">
        <NexusMark className="nx-pulse size-12" />
        Building the headquarters…
      </div>
    </div>
  ),
});

function SystemLink() {
  const { state } = useSystemStatus();
  const tone = state.kind === "loading" ? "neutral" : state.kind === "offline" ? "error" : state.readiness.status === "ok" ? "ok" : "warn";
  const label = state.kind === "loading" ? "Checking" : state.kind === "offline" ? "Backend offline" : state.readiness.status === "ok" ? "Systems operational" : "Systems degraded";
  return (
    <Link
      href="/system"
      className="flex h-10 items-center gap-2 rounded-xl bg-nx-bg/70 px-3 text-xs text-nx-muted ring-1 ring-nx-line-strong backdrop-blur-md transition hover:text-nx-text"
      title="Open the system status console"
    >
      <StatusDot tone={tone} pulse={tone === "ok"} />
      <span className="hidden sm:inline">{label}</span>
    </Link>
  );
}

function FallbackNotice() {
  const webgl = useOfficeStore((s) => s.webgl);
  if (webgl !== "unsupported" && webgl !== "lost") return null;
  return (
    <div role="status" className="pointer-events-auto rounded-xl bg-nx-warn/10 px-4 py-2 text-xs text-nx-text ring-1 ring-nx-warn/30 backdrop-blur-md">
      {webgl === "lost"
        ? "The 3D view lost its graphics context, so the 2D plan is shown. Reload to try 3D again."
        : "This browser doesn't support WebGL2, so the headquarters is shown as a 2D plan."}
    </div>
  );
}

export function Headquarters() {
  const view = useOfficeStore((s) => s.view);
  const webgl = useOfficeStore((s) => s.webgl);
  const selected = useOfficeStore((s) => s.selectedRoomId);

  // Capability detection and URL options (?view=2d, ?quality=high|balanced|low, ?perf).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const store = useOfficeStore.getState();
    const quality = params.get("quality");
    if (quality === "high" || quality === "balanced" || quality === "low") store.setQuality(quality as Quality);
    if (params.has("perf") && !store.showPerf) store.togglePerf();
    const supported = detectWebGL().webgl2 && !params.has("nowebgl");
    if (!supported) store.setWebGL("unsupported");
    else if (params.get("view") === "2d") store.setView("2d");
  }, []);

  const show3d = view === "3d" && webgl !== "unsupported" && webgl !== "lost";

  return (
    <main className="fixed inset-0 overflow-hidden">
      <h1 className="sr-only">NEXUS AI headquarters</h1>
      <div className="absolute inset-0">{show3d ? <OfficeCanvas /> : <FloorPlan2D />}</div>

      {/* HUD */}
      <div className="pointer-events-none absolute inset-0 z-20">
        <header className="pointer-events-auto absolute inset-x-3 top-3 flex flex-wrap items-center gap-3 md:inset-x-4 md:top-4 md:flex-nowrap">
          <Link href="/" className="flex h-10 shrink-0 items-center gap-2.5 rounded-xl bg-nx-bg/70 pr-3 pl-2 ring-1 ring-nx-line-strong backdrop-blur-md" aria-label="NEXUS AI headquarters">
            <NexusMark className="size-7 drop-shadow-[0_0_14px_rgb(139_92_246/0.5)]" />
            <span className="leading-tight">
              <span className="block text-xs font-semibold tracking-[0.22em] text-nx-text">NEXUS AI</span>
              <span className="block text-[11px] text-nx-muted">Headquarters</span>
            </span>
          </Link>
          <div className="order-last w-full md:order-none md:ml-6 md:w-auto">
            <RoomFinder />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <QualitySelect />
            <ViewToggle />
            <SystemLink />
          </div>
        </header>

        <div className="absolute top-1/2 left-4 hidden -translate-y-1/2 md:block">
          <FloorStack />
        </div>

        <div className={`absolute inset-x-3 flex flex-wrap items-end justify-between gap-3 md:inset-x-4 ${selected ? "bottom-[calc(44vh+1.25rem)] md:bottom-4" : "bottom-3 md:bottom-4"}`}>
          <div className="flex flex-col gap-2">
            <div className="md:hidden">
              <FloorStack />
            </div>
            <FallbackNotice />
            <CameraButtons />
          </div>
          <div className={`flex flex-col items-end gap-2 ${selected ? "md:mr-[376px]" : ""}`}>
            <PerfOverlay />
            {show3d && (
              <p className="hidden rounded-lg bg-nx-bg/60 px-3 py-1.5 text-[11px] text-nx-faint backdrop-blur-md lg:block">
                Drag to pan · Right-drag to rotate · Scroll to zoom · Click a room
              </p>
            )}
          </div>
        </div>

        <RoomPanel />
      </div>
    </main>
  );
}
