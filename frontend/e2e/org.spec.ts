import { expect, test } from "@playwright/test";

import { collectErrors, officeEmployees, waitForEmployees, waitForOffice } from "./helpers";

const STAFF = 35;

test.describe("Departments and organisation", () => {
  test("the directory lists all 20 departments with directors", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/departments");
    const cards = page.getByRole("list", { name: "Departments" }).getByRole("link");
    await expect(cards).toHaveCount(20);
    await expect(page.locator('[data-department="knowledge"]')).toContainText("Yara Nasser");
    await expect(page.locator('[data-department="engineering"]')).toContainText("Office: Engineering");
    await page.locator('[data-department="engineering"]').click();
    await expect(page.getByRole("heading", { name: "Software Engineering", level: 1 })).toBeVisible();
    await expect(page.getByTestId("team-table")).toContainText("Iris Wong");
    expect(errors).toEqual([]);
  });

  test("hiring with a desk puts the new employee at that desk in the 3D office", async ({ page }) => {
    await page.goto("/departments/finance");
    await page.getByRole("button", { name: "Hire into Finance" }).click();
    const editor = page.getByTestId("employee-editor");
    await editor.getByLabel("Name").fill("Ada Okoye");
    await editor.getByLabel("Role").selectOption("Financial Analyst");
    await editor.getByLabel("Desk").selectOption("sales-desk-4");
    await editor.getByRole("button", { name: "Hire employee" }).click();
    await expect(editor).toBeHidden();
    await expect(page.getByTestId("team-table")).toContainText("Ada Okoye");
    await expect(page.getByTestId("team-table")).toContainText("Sales · desk 4");

    await page.goto("/?ambient=off");
    await waitForOffice(page);
    await waitForEmployees(page, STAFF + 1);
    const ada = (await officeEmployees(page)).find((p) => p.name === "Ada Okoye")!;
    expect(ada.visible).toBe(true);
    expect(ada.mode).toBe("seated");
    expect(ada.floor).toBe("L1");
  });

  test("re-seating an employee makes them walk to the new desk", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/?ambient=off");
    await waitForOffice(page);
    await waitForEmployees(page, STAFF + 1);
    const search = page.getByRole("combobox", { name: "Find a room, department or employee" });
    await search.fill("Diego");
    await search.press("Enter");
    const panel = page.getByTestId("employee-panel");
    await panel.getByRole("button", { name: "Edit employee" }).click();
    const editor = page.getByTestId("employee-editor");
    await editor.getByLabel("Desk").selectOption("sales-desk-7");
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(editor).toBeHidden();
    await expect(panel).toContainText("Sales · desk 7");
    const diego = async () => (await officeEmployees(page)).find((p) => p.name === "Diego Alvarez")!;
    await expect.poll(async () => (await diego()).mode, { timeout: 10_000 }).not.toBe("seated");
    await expect.poll(async () => (await diego()).mode, { timeout: 60_000, intervals: [500] }).toBe("seated");
  });

  test("moving an employee to another department rewires their reporting line", async ({ page }) => {
    await page.goto("/departments/marketing");
    await page.getByRole("button", { name: "Edit Noah Fischer" }).click();
    const editor = page.getByTestId("employee-editor");
    await editor.getByLabel("Department").selectOption("research");
    await editor.getByLabel("Role").selectOption("Trend Analyst");
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(editor).toBeHidden();
    await expect(page.getByTestId("team-table")).not.toContainText("Noah Fischer");

    await page.goto("/departments/research");
    const row = page.getByTestId("team-table").getByRole("row", { name: /Noah Fischer/ });
    await expect(row).toContainText("Trend Analyst");
    await expect(row).toContainText("Chloé Dubois");
  });

  test("department configuration persists", async ({ page }) => {
    await page.goto("/departments/quality-assurance");
    const form = page.getByTestId("department-config");
    await form.getByLabel("Office").selectOption("engineering");
    await form.getByLabel("Max concurrent tasks").fill("4");
    await form.getByRole("button", { name: "Save configuration" }).click();
    await expect(form.getByRole("status")).toHaveText("Saved.");
    await page.reload();
    await expect(page.getByText("Office", { exact: true }).locator("..")).toContainText("Engineering");
    await expect(page.getByTestId("department-config").getByLabel("Max concurrent tasks")).toHaveValue("4");
  });

  test("the org chart is one tree under the CEO", async ({ page }) => {
    await page.goto("/org");
    const tree = page.getByTestId("org-tree");
    await expect(tree.locator(":scope > li")).toHaveCount(1);
    await expect(tree.locator(':scope > li[data-employee="Aria Vance"]')).toBeVisible();
    // Every department director appears directly under the CEO.
    await expect(tree.locator(':scope > li > ul > li[data-employee="Yara Nasser"]')).toBeVisible();
    await page.getByRole("button", { name: "Expand all" }).click();
    await expect(tree.locator('li[data-employee="Felix Schmidt"]')).toBeVisible();
  });

  test("removing an employee asks for confirmation", async ({ page }) => {
    await page.goto("/departments/finance");
    await page.getByRole("button", { name: "Edit Ada Okoye" }).click();
    const editor = page.getByTestId("employee-editor");
    await editor.getByRole("button", { name: "Remove employee…" }).click();
    await editor.getByRole("button", { name: "Yes, remove" }).click();
    await expect(editor).toBeHidden();
    await expect(page.getByTestId("team-table")).not.toContainText("Ada Okoye");
  });
});
