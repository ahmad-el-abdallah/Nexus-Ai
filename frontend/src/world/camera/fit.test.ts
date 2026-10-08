import { Box3, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { DEFAULT_AZIMUTH, DEFAULT_POLAR, fitBox, hudInsets, orientationFor } from "./fit";

const viewport = { width: 1440, height: 900 };
const none = { top: 0, right: 0, bottom: 0, left: 0 };
const q = orientationFor(DEFAULT_AZIMUTH, DEFAULT_POLAR);
const right = new Vector3(1, 0, 0).applyQuaternion(q);
const up = new Vector3(0, 1, 0).applyQuaternion(q);

function screenOffset(point: Vector3, target: Vector3, zoom: number) {
  const d = point.clone().sub(target);
  return { x: d.dot(right) * zoom, y: d.dot(up) * zoom };
}

describe("camera orientation", () => {
  it("looks from the front-right diagonal down at the building, like a camera", () => {
    const forward = new Vector3(0, 0, -1).applyQuaternion(q);
    expect(forward.x).toBeLessThan(0);
    expect(forward.z).toBeLessThan(0);
    expect(forward.y).toBeLessThan(0);
    // Screen-right points towards +x / -z for this view.
    expect(right.x).toBeGreaterThan(0);
    expect(right.z).toBeLessThan(0);
  });
});

describe("fitBox", () => {
  const box = new Box3(new Vector3(-5, 0, -5), new Vector3(5, 3, 5));

  it("centres the box when nothing covers the viewport", () => {
    const fit = fitBox(box, q, viewport, none, 0);
    const c = screenOffset(box.getCenter(new Vector3()), fit.target, fit.zoom);
    expect(c.x).toBeCloseTo(0);
    expect(c.y).toBeCloseTo(0);
  });

  it("keeps every corner inside the free area", () => {
    const insets = { top: 84, right: 392, bottom: 84, left: 96 };
    const fit = fitBox(box, q, viewport, insets, 24);
    for (let i = 0; i < 8; i++) {
      const p = new Vector3(i & 1 ? 5 : -5, i & 2 ? 3 : 0, i & 4 ? 5 : -5);
      const s = screenOffset(p, fit.target, fit.zoom);
      const px = viewport.width / 2 + s.x;
      const py = viewport.height / 2 - s.y;
      expect(px).toBeGreaterThanOrEqual(insets.left + 23.9);
      expect(px).toBeLessThanOrEqual(viewport.width - insets.right - 23.9);
      expect(py).toBeGreaterThanOrEqual(insets.top + 23.9);
      expect(py).toBeLessThanOrEqual(viewport.height - insets.bottom - 23.9);
    }
  });

  it("shifts the view away from a side panel", () => {
    const withPanel = fitBox(box, q, viewport, { top: 0, right: 400, bottom: 0, left: 0 }, 0);
    const c = screenOffset(box.getCenter(new Vector3()), withPanel.target, withPanel.zoom);
    expect(c.x).toBeCloseTo(-200);
  });

  it("reserves a bottom sheet on phones", () => {
    expect(hudInsets(390, 844, true).bottom).toBeGreaterThan(300);
    expect(hudInsets(1440, 900, true).right).toBeGreaterThan(300);
  });
});
