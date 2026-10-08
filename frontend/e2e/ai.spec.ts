import { expect, test } from "@playwright/test";

import { collectErrors } from "./helpers";

// Runs against backend/tests/fake_provider.py, never the real NVIDIA API.
const FAKE_KEY = "fake-e2e-key-0123456789abcdef";

test.describe("AI provider (NVIDIA settings)", () => {
  test.describe.configure({ mode: "serial" });

  test("shows the configured key without ever revealing it", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/settings/ai");
    await expect(page.getByTestId("key-status")).toContainText("Using NVIDIA_API_KEY from backend/.env (ends …cdef)");
    expect(await page.content()).not.toContain(FAKE_KEY);
    await expect(page.getByTestId("ai-status")).toContainText("Not tested yet");
    expect(errors).toEqual([]);
  });

  test("loads the catalogue, verifies models and picks a default", async ({ page }) => {
    await page.goto("/settings/ai");
    await page.getByRole("button", { name: "Load model list" }).click();
    const list = page.getByTestId("model-list");
    await expect(list.locator("li[data-model]")).toHaveCount(3);
    await page.getByRole("button", { name: "Verify fake/fast" }).click();
    await expect(list.locator('li[data-model="fake/fast"]')).toContainText("Verified");
    await page.getByRole("button", { name: "Verify fake/locked" }).click();
    await expect(list.locator('li[data-model="fake/locked"]')).toContainText("Not available to this key");
    await list.locator('li[data-model="fake/fast"]').getByRole("button", { name: "Set default" }).click();
    await expect(page.getByTestId("ai-status")).toContainText("Default: fake/fast");
  });

  test("runs a connection test step by step", async ({ page }) => {
    await page.goto("/settings/ai");
    await page.getByRole("button", { name: "Test connection" }).click();
    const steps = page.getByTestId("test-steps");
    await expect(steps).toContainText("3 models listed for this key");
    await expect(steps).toContainText("fake/fast replied “ready”");
    await expect(page.getByTestId("ai-status")).toContainText("Last test passed");
  });

  test("streams a reply from an employee through their routed model", async ({ page }) => {
    await page.goto("/settings/ai");
    const playground = page.getByRole("region", { name: "Playground" });
    await playground.getByLabel("Talk to").selectOption({ label: "Iris Wong — Chief Technology Officer" });
    await playground.getByLabel("Message").fill("Introduce yourself");
    await playground.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("playground-output")).toContainText("Iris Wong · fake/fast (company default)");
    await expect(page.getByTestId("playground-text")).toHaveText(/Hello from the NEXUS test provider\./);
    await expect(page.getByTestId("playground-stats")).toContainText("tokens 30 in / 7 out");
    // Usage shows the request, without the conversation text.
    await expect(page.getByTestId("usage-recent")).toContainText("playground");
    expect(await page.getByTestId("usage-recent").textContent()).not.toContain("Introduce yourself");
  });

  test("department model routing is reflected in the employee's profile", async ({ page }) => {
    await page.goto("/departments/sales");
    const form = page.getByTestId("department-config");
    await form.getByLabel("AI model for this department").selectOption("fake/fast");
    await form.getByRole("button", { name: "Save configuration" }).click();
    await expect(form.getByRole("status")).toHaveText("Saved.");
    const routing = await (await page.request.get("/api/ai/routing")).json();
    const people = await (await page.request.get("/api/employees")).json();
    const priya = people.find((p: { name: string }) => p.name === "Priya Nair");
    expect(routing.find((r: { employee_id: string }) => r.employee_id === priya.id)).toMatchObject({ model: "fake/fast", source: "department" });
  });

  test("the emergency stop blocks requests until resumed", async ({ page }) => {
    await page.goto("/settings/ai");
    await page.getByRole("button", { name: "Emergency stop" }).click();
    await expect(page.getByTestId("ai-status")).toContainText("Emergency stop is active");
    const blocked = await page.request.post("/api/ai/playground", { data: { message: "hi" } });
    expect(blocked.status()).toBe(423);
    await expect(page.getByRole("region", { name: "Playground" }).getByRole("button", { name: "Send" })).toBeDisabled();
    await page.getByRole("button", { name: "Resume AI requests" }).click();
    await expect(page.getByTestId("ai-status")).not.toContainText("Emergency stop is active");
  });

  test("a wrong saved key fails clearly and can be removed", async ({ page }) => {
    await page.goto("/settings/ai");
    await page.getByLabel("Replace with a new key").fill("wrong-key-0123456789abcdef");
    await page.getByRole("button", { name: "Save key" }).click();
    await expect(page.getByTestId("key-status")).toContainText("Using the key saved in NEXUS AI (ends …cdef)");
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.getByTestId("test-steps")).toContainText("NVIDIA rejected the API key");
    await page.getByRole("button", { name: "Remove saved key" }).click();
    await expect(page.getByTestId("key-status")).toContainText("backend/.env");
    expect(await page.content()).not.toContain("wrong-key-0123456789abcdef");
  });
});
