import { expect, test } from "@playwright/test";

import { waitForOffice } from "./helpers";

test("the headquarters fits a phone screen", async ({ page }) => {
  await page.goto("/");
  await waitForOffice(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole("navigation", { name: "Floors" }).first()).toBeVisible();

  await page.locator('[data-room-label="reception"]').click();
  const panel = page.getByTestId("room-panel");
  await expect(panel).toBeVisible();
  const box = (await panel.boundingBox())!;
  const viewport = page.viewportSize()!;
  // Bottom sheet: inside the viewport, anchored to the bottom.
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(box.y).toBeGreaterThan(viewport.height * 0.4);
  await page.screenshot({ path: "../.artifacts/e2e/mobile.png" });
});
