import { Box3, OrthographicCamera, Quaternion, Vector3 } from "three";

/** Default isometric view: camera on the front-right diagonal. */
export const DEFAULT_AZIMUTH = Math.PI / 4;
export const DEFAULT_POLAR = 0.96; // ≈ 55° from vertical, i.e. classic isometric elevation
export const MIN_POLAR = 0.42;
export const MAX_POLAR = 1.2;

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface FitResult {
  target: Vector3;
  zoom: number;
}

/** Camera orientation for given orbit angles (camera-controls conventions). */
export function orientationFor(azimuth: number, polar: number): Quaternion {
  // Must be a camera: Object3D.lookAt aims cameras down -z but other objects down +z.
  const o = new OrthographicCamera();
  o.position.setFromSphericalCoords(100, polar, azimuth);
  o.up.set(0, 1, 0);
  o.lookAt(0, 0, 0);
  return o.quaternion.clone();
}

/**
 * Frames a box for an orthographic camera (1 world unit = `zoom` pixels)
 * so it fills the part of the viewport not covered by HUD panels.
 */
export function fitBox(
  box: Box3,
  orientation: Quaternion,
  viewport: { width: number; height: number },
  insets: Insets,
  paddingPx = 24,
): FitResult {
  const right = new Vector3(1, 0, 0).applyQuaternion(orientation);
  const up = new Vector3(0, 1, 0).applyQuaternion(orientation);
  let minR = Infinity;
  let maxR = -Infinity;
  let minU = Infinity;
  let maxU = -Infinity;
  const corner = new Vector3();
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    const r = corner.dot(right);
    const u = corner.dot(up);
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
  }
  const availW = Math.max(80, viewport.width - insets.left - insets.right - paddingPx * 2);
  const availH = Math.max(80, viewport.height - insets.top - insets.bottom - paddingPx * 2);
  const zoom = Math.min(availW / Math.max(maxR - minR, 0.01), availH / Math.max(maxU - minU, 0.01));

  // Shift so the box is centred in the free area rather than the full canvas.
  const offsetRightPx = (insets.left - insets.right) / 2;
  const offsetUpPx = (insets.bottom - insets.top) / 2;
  const target = box
    .getCenter(new Vector3())
    .addScaledVector(right, -offsetRightPx / zoom)
    .addScaledVector(up, -offsetUpPx / zoom);
  return { target, zoom };
}

/** HUD space reserved around the 3D view, by breakpoint and panel state. */
export function hudInsets(width: number, height: number, panelOpen: boolean): Insets {
  if (width < 768) {
    return { top: 112, right: 12, left: 12, bottom: panelOpen ? Math.round(height * 0.46) : 92 };
  }
  return { top: 84, right: panelOpen ? 392 : 24, bottom: 84, left: 96 };
}
