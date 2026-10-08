import { expect, test } from "@playwright/test";

import { cameraState, collectErrors, officeState, type OfficeHook, settle, waitForOffice } from "./helpers";

test.describe("3D headquarters", () => {
  test("renders the office with labelled rooms and no errors", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/");
    await waitForOffice(page);
    await expect(page.getByRole("img", { name: /3D view of the NEXUS AI headquarters/ }).or(page.locator("canvas"))).toBeVisible();
    for (const id of ["executive", "meeting", "engineering", "sales", "reception", "marketing"]) {
      await expect(page.locator(`[data-room-label="${id}"]`)).toBeVisible();
    }
    // Rooms hidden under level 2 are not labelled in the overview.
    await expect(page.locator('[data-room-label="lounge"]')).toBeHidden();
    await page.screenshot({ path: "../.artifacts/e2e/overview.png" });
    expect(errors).toEqual([]);
  });

  test("clicking a room label focuses the camera and opens its details", async ({ page }) => {
    await page.goto("/");
    await waitForOffice(page);
    await settle(page);
    const before = await cameraState(page);
    await page.locator('[data-room-label="engineering"]').click();
    const panel = page.getByTestId("room-panel");
    await expect(panel.getByRole("heading", { name: "Engineering" })).toBeVisible();
    await expect(panel).toContainText("No AI employees assigned yet");
    await settle(page);
    const after = await cameraState(page);
    expect(after.zoom).toBeGreaterThan(before.zoom * 1.3);
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });

  test("clicking a room's floor in 3D selects it (raycast)", async ({ page }) => {
    await page.goto("/");
    await waitForOffice(page);
    await settle(page);
    const point = await page.evaluate(() => (window as unknown as { __NEXUS_OFFICE__: OfficeHook }).__NEXUS_OFFICE__.projectRoom("marketing"));
    expect(point).not.toBeNull();
    const box = (await page.locator("canvas").first().boundingBox())!;
    // Aim a little off-centre so the floating label isn't hit instead of the floor.
    await page.mouse.click(box.x + point!.x + 40, box.y + point!.y + 30);
    await expect(page.getByTestId("room-panel").getByRole("heading", { name: "Marketing" })).toBeVisible();
  });

  test("floor selection hides upper floors and reveals rooms beneath", async ({ page }) => {
    await page.goto("/");
    await waitForOffice(page);
    await page.getByRole("button", { name: /Ground · Lobby/ }).first().click();
    expect((await officeState(page)).activeFloor).toBe("L1");
    await expect(page.locator('[data-room-label="lounge"]')).toBeVisible();
    await expect(page.locator('[data-room-label="engineering"]')).toBeHidden();
    await page.getByRole("button", { name: "Return to headquarters overview" }).click();
    expect(await officeState(page)).toMatchObject({ activeFloor: "all", selectedRoomId: null });
  });

  test("room search jumps to rooms on other floors", async ({ page }) => {
    await page.goto("/");
    await waitForOffice(page);
    const search = page.getByRole("combobox", { name: "Find a room or department" });
    await search.fill("caf");
    await search.press("Enter");
    await expect(page.getByTestId("room-panel").getByRole("heading", { name: "Cafeteria" })).toBeVisible();
    expect((await officeState(page)).activeFloor).toBe("L1");
  });

  test("keyboard, buttons and dragging move the camera", async ({ page }) => {
    await page.goto("/");
    await waitForOffice(page);
    await settle(page);
    const start = await cameraState(page);

    await page.locator("canvas").first().click({ position: { x: 20, y: 300 } });
    await page.keyboard.press("+");
    await settle(page);
    expect((await cameraState(page)).zoom).toBeGreaterThan(start.zoom);

    await page.getByRole("button", { name: "Rotate left" }).click();
    await settle(page);
    expect((await cameraState(page)).azimuth).not.toBeCloseTo(start.azimuth, 2);

    const before = await cameraState(page);
    const box = (await page.locator("canvas").first().boundingBox())!;
    await page.mouse.move(box.x + 300, box.y + 700);
    await page.mouse.down();
    await page.mouse.move(box.x + 500, box.y + 650, { steps: 8 });
    await page.mouse.up();
    await settle(page);
    expect((await cameraState(page)).target).not.toEqual(before.target);
  });

  test("the 2D plan is available on demand", async ({ page }) => {
    await page.goto("/");
    await waitForOffice(page);
    await page.getByRole("button", { name: "2D plan" }).click();
    const plan = page.getByTestId("floor-plan-2d");
    await expect(plan).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);
    await plan.getByRole("button", { name: /^Meeting Room/ }).click();
    await expect(page.getByTestId("room-panel").getByRole("heading", { name: "Meeting Room" })).toBeVisible();
    await page.getByRole("button", { name: "3D" }).click();
    await waitForOffice(page);
  });

  test("rendering statistics come from the live renderer", async ({ page }) => {
    await page.goto("/");
    await waitForOffice(page);
    await page.getByRole("button", { name: "Show rendering statistics" }).click();
    const overlay = page.getByTestId("perf-overlay");
    await expect(overlay).toBeVisible();
    const calls = Number((await overlay.locator("dd").first().textContent()) ?? "0");
    expect(calls).toBeGreaterThan(50);
  });

  test("the system console stays reachable", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /Open the system status console|Systems|Backend offline|Checking/ }).click();
    await expect(page).toHaveURL(/\/system$/);
    await expect(page.getByRole("heading", { name: "System status" })).toBeVisible();
  });
});
