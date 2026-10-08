import { expect, test } from "@playwright/test";

import { collectErrors, officeEmployees, type OfficeHook, settle, waitForEmployees, waitForOffice } from "./helpers";

const STAFF = 35;
const ON_SITE = 19;

test.describe("AI employees", () => {
  test("every employee with a desk appears seated at it, idle", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/");
    await waitForOffice(page);
    await waitForEmployees(page, STAFF);
    const people = await officeEmployees(page);
    expect(new Set(people.map((p) => p.id)).size).toBe(STAFF);
    // Everyone with a desk is seated; the rest work remotely and aren't drawn.
    expect(people.filter((p) => p.visible)).toHaveLength(ON_SITE);
    for (const p of people) {
      expect(p.mode, p.name).toBe(p.visible ? "seated" : "away");
      expect(p.status, p.name).toBe("idle");
    }
    await expect(page.getByTestId("staff-chip")).toContainText(`${STAFF} AI employees`);
    await expect(page.getByTestId("staff-chip")).toContainText(`${STAFF} idle`);
    expect(errors).toEqual([]);
  });

  test("clicking a character selects that employee", async ({ page }) => {
    await page.goto("/?ambient=off");
    await waitForOffice(page);
    await waitForEmployees(page, STAFF);
    await settle(page);
    const target = (await officeEmployees(page)).find((p) => p.name === "Iris Wong")!;
    const point = await page.evaluate((id) => (window as unknown as { __NEXUS_OFFICE__: OfficeHook }).__NEXUS_OFFICE__.projectEmployee(id), target.id);
    const box = (await page.locator("canvas").first().boundingBox())!;
    await page.mouse.click(box.x + point!.x, box.y + point!.y);
    const panel = page.getByTestId("employee-panel");
    await expect(panel.getByRole("heading", { name: "Iris Wong" })).toBeVisible();
    await expect(panel).toContainText("Chief Technology Officer");
    await expect(page.getByTestId("employee-status")).toContainText("Idle");
    await expect(panel).toContainText("Engineering · desk 1");
  });

  test("suspending walks the employee out; activating brings them back", async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto("/?ambient=off");
    await waitForOffice(page);
    await waitForEmployees(page, STAFF);
    const search = page.getByRole("combobox", { name: "Find a room, department or employee" });
    await search.fill("Hana");
    await search.press("Enter");
    const panel = page.getByTestId("employee-panel");
    await expect(panel.getByRole("heading", { name: "Hana Kobayashi" })).toBeVisible();

    await panel.getByRole("button", { name: "Suspend employee" }).click();
    await expect(page.getByTestId("employee-status")).toContainText("Suspended");
    const hana = async () => (await officeEmployees(page)).find((p) => p.name === "Hana Kobayashi")!;
    await expect.poll(async () => (await hana()).mode, { timeout: 15_000 }).not.toBe("seated");
    await expect.poll(async () => (await hana()).mode, { timeout: 60_000, intervals: [1000] }).toBe("away");
    await expect(page.getByTestId("employee-doing")).toContainText("Away");

    // The change is persisted in the backend, not just the page.
    const saved = await page.request.get(`/api/employees/${(await hana()).id}`);
    expect((await saved.json()).status).toBe("suspended");

    await panel.getByRole("button", { name: "Activate employee" }).click();
    await expect(page.getByTestId("employee-status")).toContainText("Idle");
    await expect.poll(async () => (await hana()).mode, { timeout: 60_000, intervals: [1000] }).toBe("seated");
  });

  test("room panels list their real team", async ({ page }) => {
    await page.goto("/");
    await waitForOffice(page);
    await waitForEmployees(page, STAFF);
    await page.locator('[data-room-label="marketing"]').click();
    const panel = page.getByTestId("room-panel");
    await expect(panel).toContainText("6 of 6 desks filled");
    await panel.getByRole("button", { name: /Elena Rossi/ }).click();
    await expect(page.getByTestId("employee-panel").getByRole("heading", { name: "Elena Rossi" })).toBeVisible();
  });
});

test("the character studio previews every animation state", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/characters");
  await expect(page.getByRole("heading", { name: "Character studio" })).toBeVisible();
  await expect(page.getByText("not real employees or live statuses")).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();
  for (const label of ["Working", "Researching", "In a meeting", "Reviewing", "Blocked / error", "Task completed"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Generate new people" }).click();
  await page.screenshot({ path: "../.artifacts/e2e/character-studio.png" });
  expect(errors).toEqual([]);
});
