"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect } from "react";

import { NexusMark } from "@/components/NexusMark";
import { StatusDot } from "@/components/StatusPill";
import { useSystemStatus } from "@/hooks/useSystemStatus";
import { detectWebGL } from "@/lib/webgl";
import { STATUS_META } from "@/world/characters/status";
import { FloorPlan2D } from "@/world/plan2d/FloorPlan2D";
import { startRosterSync, useEmployeeStore } from "@/world/state/employeeStore";
import { startScreenSync } from "@/world/state/screenStore";
import { type Quality, useOfficeStore } from "@/world/state/officeStore";

import { NavLinks } from "@/components/org/AppShell";

import { CameraButtons, FloorStack, PerfOverlay, QualitySelect, ViewToggle } from "./Controls";
import { EmployeePanel } from "./EmployeePanel";
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
      className="flex h-10 shrink-0 items-center gap-2 rounded-xl bg-nx-bg/70 px-3 text-xs text-nx-muted ring-1 ring-nx-line-strong backdrop-blur-md transition hover:text-nx-text"
      title={`${label} — open the system status console`}
      aria-label={label}
    >
      <StatusDot tone={tone} pulse={tone === "ok"} />
      <span className="hidden 2xl:inline">{label}</span>
    </Link>
  );
}

/** Real headcount from the roster, by status. */
function StaffChip() {
  const employees = useEmployeeStore((s) => s.employees);
  const load = useEmployeeStore((s) => s.load);
  if (load === "error" && employees.length === 0) {
    return (
      <span className="hidden h-10 items-center rounded-xl bg-nx-bg/70 px-3 text-xs text-nx-error ring-1 ring-nx-error/30 backdrop-blur-md md:flex" role="status">
        Roster unavailable
      </span>
    );
  }
  if (employees.length === 0) return null;
  const remote = employees.filter((e) => !e.desk_id).length;
  const counts = new Map<string, number>();
  for (const e of employees) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
  // Full breakdown on hover; the chip itself stays short so the header never overflows.
  const breakdown = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, n]) => `${n} ${STATUS_META[status as keyof typeof STATUS_META].label.toLowerCase()}`)
    .join(" · ");
  const idle = counts.get("idle") ?? 0;
  const suspended = counts.get("suspended") ?? 0;
  const busy = employees.length - idle - suspended;
  const summary = [`${idle} idle`, busy ? `${busy} busy` : null, suspended ? `${suspended} suspended` : null].filter(Boolean).join(" · ");
  return (
    <span
      data-testid="staff-chip"
      className="hidden h-10 shrink-0 items-center gap-2 rounded-xl bg-nx-bg/70 px-3 text-xs whitespace-nowrap text-nx-muted ring-1 ring-nx-line-strong backdrop-blur-md xl:flex"
      title={`AI employees by current status: ${breakdown}`}
    >
      <span className="font-semibold text-nx-text">{employees.length} AI employees</span>
      {summary}
      {remote > 0 && <span className="text-nx-faint">· {remote} remote</span>}
    </span>
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
  const selected = useOfficeStore((s) => s.selectedRoomId ?? s.selectedEmployeeId);

  useEffect(() => startRosterSync(), []);
  useEffect(() => startScreenSync(), []);

  // Capability detection and URL options (?view=2d, ?quality=high|balanced|low, ?perf).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const store = useOfficeStore.getState();
    const quality = params.get("quality");
    if (quality === "high" || quality === "balanced" || quality === "low") store.setQuality(quality as Quality);
    if (params.has("perf") && !store.showPerf) store.togglePerf();
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || params.get("ambient") === "off") store.setAmbient(false);
    const room = params.get("room");
    if (room) store.selectRoom(room);
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
          <div className="hidden rounded-xl bg-nx-bg/70 p-1 ring-1 ring-nx-line-strong backdrop-blur-md lg:block">
            <NavLinks compact />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <StaffChip />
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
        <EmployeePanel />
      </div>
    </main>
  );
}
