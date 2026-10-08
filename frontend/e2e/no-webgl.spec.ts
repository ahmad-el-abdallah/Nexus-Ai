import { expect, test } from "@playwright/test";

import { collectErrors } from "./helpers";

test("without WebGL the headquarters falls back to a working 2D plan", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await expect(page.getByTestId("floor-plan-2d")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "WebGL2" })).toBeVisible();
  await expect(page.getByRole("button", { name: "3D" })).toBeDisabled();
  await page.getByTestId("floor-plan-2d").getByRole("button", { name: /^Sales/ }).click();
  await expect(page.getByTestId("room-panel").getByRole("heading", { name: "Sales" })).toBeVisible();
  expect(errors).toEqual([]);
});
