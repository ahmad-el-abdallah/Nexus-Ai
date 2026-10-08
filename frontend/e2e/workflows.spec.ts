import { expect, test } from "@playwright/test";

import { collectErrors } from "./helpers";

// Agents answer through backend/tests/fake_provider.py (canned replies per step format);
// the real NVIDIA API is never called.
const OBJECTIVE = "Research a new software business opportunity and create an implementation plan.";

test.describe("Multi-agent workflows", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ request }) => {
    expect((await request.post("/api/ai/models/refresh")).ok()).toBe(true);
    expect((await request.patch("/api/ai/settings", { data: { default_model: "fake/fast", paused: false, daily_request_budget: 500 } })).ok()).toBe(true);
  });

  test("the CEO plans, the owner approves, departments deliver and the CEO consolidates", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/workflows");
    await page.getByRole("button", { name: "Use the example" }).click();
    await page.getByRole("button", { name: "Ask the CEO to plan it" }).click();
    await expect(page).toHaveURL(/\/workflows\/wf_/);

    // Owner checkpoint: the plan waits for approval.
    const status = page.getByRole("region", { name: "Status" });
    const plan = page.getByTestId("plan-review");
    await expect(plan).toBeVisible();
    await expect(status.getByTestId("workflow-status")).toHaveText("Waiting for your approval");
    await expect(plan.getByTestId("plan-assignment")).toHaveCount(2);
    await expect(plan).toContainText("Market Research & Innovation");
    await expect(plan).toContainText("Software Engineering");
    await expect(plan).toContainText("Starts after:");
    await expect(status).toContainText("1/45 requests");

    await plan.getByRole("button", { name: /Approve and run \(2 departments\)/ }).click();
    await expect(status.getByTestId("workflow-status")).toHaveText(/Running|CEO is writing the report|Completed/);

    // Live progress until the CEO's report.
    await expect(status.getByTestId("workflow-status")).toHaveText("Completed", { timeout: 45_000 });
    await expect(page.getByTestId("final-report")).toContainText("The company recommends a focused pilot.");
    const engineering = page.locator('[data-testid="assignment"][data-department="engineering"]');
    await expect(engineering).toHaveAttribute("data-status", "done");
    await expect(engineering.getByTestId("work-task")).toHaveCount(2);
    await expect(engineering).toContainText("Needs: Market Research & Innovation ✓");
    const timeline = page.getByTestId("timeline");
    await expect(timeline).toContainText("Market Research & Innovation → Software Engineering");
    await expect(timeline).toContainText("delegated");
    await expect(timeline).toContainText("delivered the final report");
    // The counter shows the real number of model requests, within the plan's estimate.
    const id = page.url().split("/").pop();
    const detail = await (await page.request.get(`/api/workflows/${id}`)).json();
    await expect(status).toContainText(`${detail.calls_used}/45 requests`);
    expect(detail.calls_used).toBeGreaterThanOrEqual(5);
    expect(detail.calls_used).toBeLessThanOrEqual(detail.estimate.worst + 1);

    // The department's board shows its workflow tasks.
    await page.goto("/departments/engineering");
    await expect(page.getByTestId("task").first()).toContainText("Done");
    await expect(page.getByRole("link", { name: "workflow →" }).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("delegating from a CEO chat posts notices there, and a workflow can be cancelled", async ({ page, request }) => {
    const roster = await (await request.get("/api/employees")).json();
    const ceo = roster.find((e: { role: string }) => e.role === "Chief Executive Officer");
    await page.goto(`/chat?to=employee:${ceo.id}`);
    await page.getByRole("textbox", { name: "Message" }).fill(OBJECTIVE);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator('[data-testid="message"][data-role="agent"]').last()).toHaveAttribute("data-status", "complete");
    await page.locator('[data-testid="message"][data-role="owner"]').last().getByRole("button", { name: "Delegate to CEO" }).click();
    await expect(page).toHaveURL(/\/workflows\/wf_/);
    const status = page.getByRole("region", { name: "Status" });
    await expect(page.getByTestId("plan-review")).toBeVisible();

    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Cancel workflow" }).click();
    await expect(status.getByTestId("workflow-status")).toHaveText("Cancelled");

    await page.getByRole("link", { name: "from chat" }).click();
    const notices = page.locator('[data-testid="message"][data-role="system"]');
    await expect(notices.filter({ hasText: "Workflow started" })).toHaveCount(1);
    await expect(notices.filter({ hasText: "plan is ready" })).toHaveCount(1);
    await expect(notices.filter({ hasText: "Workflow cancelled" })).toHaveCount(1);
  });
});
