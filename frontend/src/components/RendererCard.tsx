"use client";

import { useSyncExternalStore } from "react";

import { detectWebGL, type WebGLSupport } from "@/lib/webgl";

import { StatusPill } from "./StatusPill";

let cached: WebGLSupport | undefined;
const subscribe = () => () => {};
const getSnapshot = () => (cached ??= detectWebGL());
const getServerSnapshot = () => null;

/** Reports whether this browser can render the 3D headquarters. */
export function RendererCard() {
  const support = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return (
    <section className="glass flex flex-col gap-4 p-6" aria-labelledby="renderer-title">
      <header className="flex items-center justify-between gap-3">
        <h2 id="renderer-title" className="text-base font-semibold text-nx-text">
          3D readiness
        </h2>
        {support === null ? (
          <StatusPill tone="neutral">Detecting</StatusPill>
        ) : support.webgl2 ? (
          <StatusPill tone="ok">WebGL2 available</StatusPill>
        ) : (
          <StatusPill tone="warn">WebGL2 unavailable</StatusPill>
        )}
      </header>
      <p className="text-sm leading-6 text-nx-muted">
        {support === null
          ? "Checking this browser's graphics support…"
          : support.webgl2
            ? "This browser can render the 3D headquarters that opens in Stage 2."
            : "The 3D headquarters will fall back to a 2D office plan in this browser."}
      </p>
      {support?.renderer && (
        <p className="rounded-lg bg-white/[0.03] px-3 py-2 font-mono text-xs break-words text-nx-faint ring-1 ring-nx-line">
          {support.renderer}
        </p>
      )}
    </section>
  );
}
