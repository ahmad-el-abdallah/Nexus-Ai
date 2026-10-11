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

test("the Digital Vault fits a phone screen", async ({ page }) => {
  await page.goto("/vault");
  await expect(page.getByRole("heading", { name: "Digital Vault" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole("complementary", { name: "Vault navigation" })).toBeVisible();
  await expect(page.getByPlaceholder(/Search names/)).toBeVisible();
  await page.screenshot({ path: "../.artifacts/e2e/digital-vault-dc5-mobile.png", fullPage: true });
});

test("the Vault dashboard and engineering projects fit a phone screen", async ({ page }) => {
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.goto("/vault/dashboard");
  await expect(page.getByTestId("dashboard-tile")).toHaveCount(6);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "../.artifacts/e2e/digital-vault-dc7-dashboard-mobile.png", fullPage: true });

  await page.goto("/vault/projects");
  const projects = await (await page.request.get("/api/storage/projects")).json();
  if (projects.length) await expect(page.getByRole("heading", { level: 2, name: projects[0].name })).toBeVisible();
  else await expect(page.getByRole("heading", { name: "No engineering projects yet" })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "../.artifacts/e2e/digital-vault-dc7-projects-mobile.png", fullPage: true });
});

test("the Vault protection screen fits a phone screen", async ({ page }) => {
  await page.goto("/vault/protection");
  await expect(page.getByTestId("protection-tile")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Back up now" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "../.artifacts/e2e/digital-vault-dc8-protection-mobile.png", fullPage: true });
});
