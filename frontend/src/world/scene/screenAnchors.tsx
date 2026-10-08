"use client";

/**
 * DOM labels pinned to 3D points, without a React root per label.
 *
 * `<ScreenLabel>` renders a normal element in the page's React tree (inside an
 * overlay next to the canvas); `<ScreenAnchors>` lives inside the R3F Canvas and,
 * after every rendered frame, writes each label's screen position straight to its
 * style. (drei's <Html> creates a separate React root per label, which React Strict
 * Mode in development reports as "Attempted to synchronously unmount a root".)
 */

import { useFrame, useThree } from "@react-three/fiber";
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Vector3 } from "three";

type Point = readonly [number, number, number];

interface Anchor {
  el: HTMLElement;
  point: Point;
}

interface Layer {
  anchors: Set<Anchor>;
  invalidate: (() => void) | null;
}

const layers = new Map<string, Layer>();

function layerOf(name: string): Layer {
  let layer = layers.get(name);
  if (!layer) {
    layer = { anchors: new Set(), invalidate: null };
    layers.set(name, layer);
  }
  return layer;
}

/** Inside the Canvas: keeps every label of `layer` over its 3D point. */
export function ScreenAnchors({ layer }: { layer: string }) {
  const invalidate = useThree((s) => s.invalidate);
  const v = useMemo(() => new Vector3(), []);

  useEffect(() => {
    const l = layerOf(layer);
    l.invalidate = invalidate;
    invalidate(); // position labels that registered before the canvas existed
    return () => {
      if (l.invalidate === invalidate) l.invalidate = null;
    };
  }, [layer, invalidate]);

  useFrame(({ camera, size }) => {
    for (const a of layerOf(layer).anchors) {
      v.set(a.point[0], a.point[1], a.point[2]).project(camera);
      const offscreen = v.z < -1 || v.z > 1;
      const x = ((v.x + 1) / 2) * size.width;
      const y = ((1 - v.y) / 2) * size.height;
      a.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
      a.el.style.visibility = offscreen ? "hidden" : "";
      // Nearer labels above farther ones.
      a.el.style.zIndex = String(Math.round((1 - v.z) * 500));
    }
  });
  return null;
}

/** A DOM element shown over a 3D point. Render it inside an overlay that covers the canvas. */
export function ScreenLabel({
  layer,
  point,
  className = "",
  style,
  children,
}: {
  layer: string;
  point: Point;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [x, y, z] = point;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const l = layerOf(layer);
    const anchor: Anchor = { el, point: [x, y, z] };
    el.style.visibility = "hidden"; // until the first frame places it
    l.anchors.add(anchor);
    l.invalidate?.();
    return () => {
      l.anchors.delete(anchor);
    };
  }, [layer, x, y, z]);
  return (
    <div ref={ref} className={`absolute top-0 left-0 ${className}`} style={style}>
      {children}
    </div>
  );
}
