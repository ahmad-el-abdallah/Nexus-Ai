import { expect, type Page } from "@playwright/test";

export interface OfficeHook {
  state: () => { activeFloor: string; selectedRoomId: string | null; view: string; quality: string };
  camera: () => { zoom: number; azimuth: number; polar: number; target: number[]; overviewZoom: number };
  projectRoom: (id: string) => { x: number; y: number } | null;
  projectEmployee: (id: string) => { x: number; y: number } | null;
  employees: () => Array<{ id: string; name: string; status: string; mode: string; doing: string; floor: string; visible: boolean }>;
}

export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

/** Waits until the 3D office has rendered real geometry. */
export async function waitForOffice(page: Page) {
  await page.waitForFunction(() => {
    const perf = (window as unknown as { __NEXUS_PERF__?: { frames: number; drawCalls: number } }).__NEXUS_PERF__;
    return !!perf && perf.frames > 0 && perf.drawCalls > 50 && !!(window as unknown as { __NEXUS_OFFICE__?: unknown }).__NEXUS_OFFICE__;
  });
}

export const officeState = (page: Page) =>
  page.evaluate(() => (window as unknown as { __NEXUS_OFFICE__: OfficeHook }).__NEXUS_OFFICE__.state());
export const cameraState = (page: Page) =>
  page.evaluate(() => (window as unknown as { __NEXUS_OFFICE__: OfficeHook }).__NEXUS_OFFICE__.camera());

/** Waits for camera transitions to settle. */
export async function settle(page: Page) {
  let last = "";
  await expect
    .poll(async () => {
      const now = JSON.stringify(await cameraState(page));
      const same = now === last;
      last = now;
      return same;
    }, { intervals: [300, 300, 300, 300, 300, 500, 500, 1000] })
    .toBe(true);
}

export const officeEmployees = (page: Page) =>
  page.evaluate(() => (window as unknown as { __NEXUS_OFFICE__: OfficeHook }).__NEXUS_OFFICE__.employees());

/** Waits until the roster has loaded into the 3D office. */
export async function waitForEmployees(page: Page, count: number) {
  await expect.poll(async () => (await officeEmployees(page)).length, { timeout: 20_000 }).toBe(count);
}
