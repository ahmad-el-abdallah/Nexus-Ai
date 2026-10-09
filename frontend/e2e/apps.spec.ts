import { expect, test } from "@playwright/test";

import { collectErrors } from "./helpers";

// Engineers answer through backend/tests/fake_provider.py (a small real notes app, file by
// file); the real NVIDIA API is never called. The app itself really runs in the sandbox.
const REQUEST = "A shared list of notes for my team: add a note and see everyone's notes.";

test.describe("Apps built by the engineering team", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ request }) => {
    expect((await request.post("/api/ai/models/refresh")).ok()).toBe(true);
    expect((await request.patch("/api/ai/settings", { data: { default_model: "fake/fast", paused: false, daily_request_budget: 500 } })).ok()).toBe(true);
  });

  test("design, approval, files by role, download, run in the sandbox, and a change request", async ({ page, context, request }) => {
    test.setTimeout(240_000);
    const errors = collectErrors(page);
    await page.goto("/apps");
    await page.getByRole("textbox", { name: "What the app should do" }).fill(REQUEST);
    await page.getByRole("button", { name: "Ask for a design" }).click();
    await expect(page).toHaveURL(/\/apps\/app_/);
    const id = page.url().split("/").pop();

    // Owner checkpoint: the design shows who writes what, and nothing is written yet.
    const status = page.getByRole("region", { name: "Status" });
    const design = page.getByTestId("app-design");
    await expect(design).toBeVisible();
    await expect(status.getByTestId("app-status")).toHaveText("Waiting for your approval");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Team Notes");
    await expect(design.getByTestId("design-file")).toHaveCount(4);
    await expect(design.locator('[data-testid="design-file"][data-area="backend"]')).toContainText("Yusuf Demir · Backend Developer");
    await expect(design.locator('[data-testid="design-file"][data-area="frontend"]').first()).toContainText("Amara Mensah · Frontend Developer");
    await expect(design.locator('[data-testid="design-file"][data-area="docs"]')).toContainText("Felix Schmidt · Software Architect");
    await expect(design).toContainText("Nothing has been written yet.");
    await expect(status).toContainText("1/45 requests");
    await expect(page.getByTestId("app-run")).toHaveCount(0);

    await design.getByRole("button", { name: "Approve and build (4 files)" }).click();
    await expect(status.getByTestId("app-status")).toHaveText("Ready", { timeout: 90_000 });
    await expect(page.getByTestId("app-delivery")).toContainText("Team Notes is stored.");
    await expect(page.locator('[data-testid="app-file"][data-status="written"]')).toHaveCount(4);
    const timeline = page.getByTestId("app-timeline");
    await expect(timeline).toContainText("Yusuf Demir (Backend Developer) wrote server.py");
    await expect(timeline).toContainText("Amara Mensah (Frontend Developer) wrote static/app.js");
    await expect(timeline).toContainText("Automatic syntax checks:");
    const detail = await (await request.get(`/api/apps/${id}`)).json();
    await expect(status).toContainText(`${detail.calls_used}/45 requests`);
    expect(detail.calls_used).toBe(7); // design + 4 files + review + delivery note

    // The stored files can be read and downloaded.
    const server = page.locator('[data-testid="app-file"][data-path="server.py"]');
    await server.getByRole("button", { name: /server\.py/ }).click();
    await expect(server.getByTestId("app-file-content")).toContainText("ThreadingHTTPServer");
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "⬇ Download .zip" }).click();
    expect((await download).suggestedFilename()).toBe("team-notes-v1.zip");

    // Run it without downloading — only after approving this version.
    const runtime = await (await request.get("/api/apps/runtime")).json();
    const panel = page.getByTestId("app-run");
    if (runtime.available) {
      await panel.getByRole("button", { name: "▶ Run app" }).click();
      const dialog = page.getByTestId("app-run-dialog");
      await expect(dialog).toContainText("No packages to install");
      await expect(dialog).toContainText("No internet access while the app runs");
      expect((await (await request.get(`/api/apps/${id}`)).json()).run).toBeNull();
      await dialog.getByRole("button", { name: "Approve and run" }).click();
      await expect(panel.getByTestId("app-run-status")).toHaveText("Running in the sandbox", { timeout: 60_000 });
      await expect(panel.getByTestId("app-run-log")).toContainText("Team Notes is listening");

      const [app] = await Promise.all([context.waitForEvent("page"), panel.getByTestId("app-open").click()]);
      await expect(app.getByRole("heading", { name: "Team Notes" })).toBeVisible();
      expect(new URL(app.url()).port).toBe(String(runtime.port)); // its own origin, not NEXUS's
      await app.getByRole("textbox", { name: "Note" }).fill("Ship the first version");
      await app.getByRole("button", { name: "Add" }).click();
      await expect(app.getByRole("listitem")).toHaveText("Ship the first version");
      await app.close();

      await panel.getByRole("button", { name: "■ Stop" }).click();
      await expect(panel.getByTestId("app-run-status")).toHaveText("Stopped");
      await expect(panel.getByRole("button", { name: "▶ Run app" })).toBeEnabled();
    } else {
      await expect(panel).toContainText("Apps can't be run on this computer");
    }

    // A change request makes version 2 and rewrites only what it touches.
    const change = page.getByTestId("app-change");
    await change.getByRole("textbox", { name: "The change you want" }).fill("Add an About page.");
    await change.getByRole("button", { name: "Ask for this change" }).click();
    await expect(design).toContainText("The planned change — your approval is needed");
    await expect(design.getByTestId("design-file")).toHaveCount(2);
    await expect(design).toContainText("3 other files stay as they are.");
    await design.getByRole("button", { name: "Approve and build (2 files)" }).click();
    await expect(status.getByTestId("app-status")).toHaveText("Ready", { timeout: 90_000 });
    await expect(status.getByRole("button", { name: "Version 2" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("app-file")).toHaveCount(5);
    await expect(page.locator('[data-testid="app-file"][data-path="server.py"]')).toContainText("Unchanged");
    await status.getByRole("button", { name: "Version 1" }).click();
    await expect(page.getByTestId("app-file")).toHaveCount(4);
    await expect(status).toContainText("You are looking at an earlier version.");

    await page.goto("/apps");
    await expect(page.getByTestId("app-row").first()).toContainText("Team Notes");
    await expect(page.getByTestId("app-row").first()).toContainText("Ready");
    expect(errors).toEqual([]);
  });

  test("building from an engineering chat posts notices there, and a build can be cancelled", async ({ page, request }) => {
    const roster = await (await request.get("/api/employees")).json();
    const cto = roster.find((e: { role: string }) => e.role === "Chief Technology Officer");
    await page.goto(`/chat?to=employee:${cto.id}`);
    await page.getByRole("textbox", { name: "Message" }).fill(REQUEST);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator('[data-testid="message"][data-role="agent"]').last()).toHaveAttribute("data-status", "complete");
    await page.locator('[data-testid="message"][data-role="owner"]').last().getByRole("button", { name: "Build as app" }).click();
    await expect(page).toHaveURL(/\/apps\/app_/);
    await expect(page.getByTestId("app-design")).toBeVisible();

    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Cancel build" }).click();
    await expect(page.getByRole("region", { name: "Status" }).getByTestId("app-status")).toHaveText("Cancelled");

    await page.getByRole("link", { name: "from chat" }).click();
    const notices = page.locator('[data-testid="message"][data-role="system"]');
    await expect(notices.filter({ hasText: "App requested" })).toHaveCount(1);
    await expect(notices.filter({ hasText: "Review who writes what" })).toHaveCount(1);
    await expect(notices.filter({ hasText: "App build cancelled" })).toHaveCount(1);

    // Leave no conversation behind: other specs count the ones they create.
    const conversations: { id: string; employee_id: string | null }[] = await (await request.get("/api/conversations")).json();
    for (const c of conversations.filter((c) => c.employee_id === cto.id)) {
      expect((await request.delete(`/api/conversations/${c.id}`)).status()).toBe(204);
    }
  });
});
