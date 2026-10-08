import { expect, test } from "@playwright/test";

import { collectErrors } from "./helpers";

// Replies come from backend/tests/fake_provider.py, never the real NVIDIA API.
const REPLY = "Hello from the NEXUS test provider.";

test.describe("Text communication", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ request }) => {
    expect((await request.post("/api/ai/models/refresh")).ok()).toBe(true);
    const r = await request.patch("/api/ai/settings", { data: { default_model: "fake/fast", paused: false } });
    expect(r.ok()).toBe(true);
  });

  test("the owner messages Marketing and its director replies, streamed and saved", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/departments/marketing");
    await page.getByRole("link", { name: "Message Marketing" }).click();
    await expect(page).toHaveURL(/\/chat\?to=department:marketing/);
    await expect(page.getByTestId("conversation-title")).toHaveText("New conversation with Marketing department");
    await expect(page.getByText("Answered by Elena Rossi, director")).toBeVisible();

    await page.getByRole("textbox", { name: "Message" }).fill("What is our **launch** plan?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page).toHaveURL(/\/chat\?c=cnv_/);
    const reply = page.locator('[data-testid="message"][data-role="agent"]').last();
    await expect(reply).toContainText("Elena Rossi · Chief Marketing Officer · Marketing");
    await expect(reply).toContainText(REPLY);
    await expect(reply).toHaveAttribute("data-status", "complete");
    await expect(reply).toContainText("fake/fast · 30 in / 7 out tokens");
    await expect(page.locator('[data-testid="message"][data-role="owner"] strong')).toHaveText("launch");
    await expect(page.getByTestId("conversation-title")).toHaveText("What is our launch plan?");

    // Persists across a reload.
    await page.reload();
    await expect(page.locator('[data-testid="message"][data-role="agent"]').last()).toContainText(REPLY);
    expect(errors).toEqual([]);
  });

  test("Engineering and the CEO are answered by the right people", async ({ page }) => {
    await page.goto("/chat?new=1");
    const picker = page.getByTestId("new-conversation");
    await picker.getByRole("button", { name: "Message Software Engineering" }).click();
    await page.getByRole("textbox", { name: "Message" }).fill("Status of the API?");
    await page.keyboard.press("Enter");
    const reply = page.locator('[data-testid="message"][data-role="agent"]').last();
    await expect(reply).toContainText("Iris Wong · Chief Technology Officer · Software Engineering");
    await expect(reply).toHaveAttribute("data-status", "complete");

    await page.goto("/chat?new=1");
    await page.getByRole("button", { name: /Message the CEO/ }).click();
    await page.getByRole("textbox", { name: "Message" }).fill("Company update please");
    await page.keyboard.press("Enter");
    const ceo = page.locator('[data-testid="message"][data-role="agent"]').last();
    await expect(ceo).toContainText("Aria Vance · Chief Executive Officer");
    await expect(ceo).toContainText(REPLY);
  });

  test("conversations are searchable and open at the matching message", async ({ page }) => {
    await page.goto("/chat");
    const list = page.getByRole("list", { name: "Conversations" });
    await expect(list.getByRole("button")).toHaveCount(3);
    await page.getByRole("searchbox", { name: "Search conversations" }).fill("the API");
    await expect(list.getByRole("button")).toHaveCount(1);
    await expect(list).toContainText("Status of the API?");
    await list.getByRole("button").first().click();
    await expect(page).toHaveURL(/c=cnv_.*&m=\d+/);
    await expect(page.locator('[data-testid="message"][data-role="agent"]').last()).toContainText("Iris Wong");
  });

  test("text files are read by the model; a task is created from a message", async ({ page }) => {
    await page.goto("/chat?to=department:marketing");
    await page.getByTestId("file-input").setInputFiles({ name: "brief.md", mimeType: "text/markdown", buffer: Buffer.from("# Brief\nAudience: developers") });
    await expect(page.getByRole("list", { name: "Files to send" })).toContainText("brief.md");
    await page.getByRole("textbox", { name: "Message" }).fill("Review the attached brief");
    await page.getByRole("button", { name: "Send" }).click();
    const owner = page.locator('[data-testid="message"][data-role="owner"]').last();
    await expect(owner.getByRole("link", { name: /brief\.md/ })).toContainText("read by the model");
    const reply = page.locator('[data-testid="message"][data-role="agent"]').last();
    await expect(reply).toHaveAttribute("data-status", "complete");

    await owner.getByRole("button", { name: "Create task" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("textbox", { name: "Title" })).toHaveValue("Review the attached brief");
    await dialog.getByRole("button", { name: "Create task" }).click();
    await expect(dialog).toContainText("open — not started");
    await dialog.getByRole("link", { name: "Open task board" }).click();
    await expect(page).toHaveURL(/\/departments\/marketing/);
    await expect(page.getByTestId("task").first()).toContainText("Review the attached brief");
    await expect(page.getByTestId("task").first()).toContainText("Open · not started");
  });

  test("status changes arrive live, without waiting for a poll", async ({ page, request }) => {
    await page.goto("/departments/sales");
    const row = page.getByTestId("team-table").getByRole("row", { name: /Diego Alvarez/ });
    await expect(row).toContainText("Idle");
    const roster = await (await request.get("/api/employees")).json();
    const diego = roster.find((e: { name: string }) => e.name === "Diego Alvarez");
    const started = Date.now();
    await request.post(`/api/employees/${diego.id}/suspend`);
    await expect(row).toContainText("Suspended", { timeout: 3_000 });
    expect(Date.now() - started).toBeLessThan(3_000);
    await request.post(`/api/employees/${diego.id}/activate`);
    await expect(row).toContainText("Idle", { timeout: 3_000 });
  });

  test("a suspended employee can't be messaged and the page says why", async ({ page, request }) => {
    const roster = await (await request.get("/api/employees")).json();
    const leo = roster.find((e: { name: string }) => e.name === "Leo Park");
    await request.post(`/api/employees/${leo.id}/suspend`);
    await page.goto(`/chat?to=employee:${leo.id}`);
    await expect(page.getByText("Leo Park is suspended. Activate them to continue this conversation.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
    await request.post(`/api/employees/${leo.id}/activate`);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 3_000 });
  });
});
