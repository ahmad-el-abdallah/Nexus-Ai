import { expect, test, type APIRequestContext } from "@playwright/test";

import { collectErrors } from "./helpers";

// Engineers answer through backend/tests/fake_provider.py; the real NVIDIA API is never called.
const REQUEST = "A shared list of notes for my team: add a note and see everyone's notes.";

async function waitForApp(request: APIRequestContext, id: string, status: string) {
  await expect
    .poll(async () => (await (await request.get(`/api/apps/${id}`)).json()).status, { timeout: 90_000 })
    .toBe(status);
}

test("a file keeps every version: upload a new one, compare, restore", async ({ page, request }) => {
  const errors = collectErrors(page);
  const failedResponses: string[] = [];
  page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

  const uploaded = await request.post("/api/storage/workspaces/ws_company/files", {
    multipart: { file: { name: "dc7-plan.md", mimeType: "text/markdown", buffer: Buffer.from("# Plan\nShip on Monday.\n") } },
  });
  expect(uploaded.ok()).toBe(true);
  const entry = await uploaded.json();

  await page.goto("/vault");
  await page.getByTestId("vault-item").filter({ has: page.getByText("dc7-plan.md", { exact: true }) }).getByText("dc7-plan.md", { exact: true }).click();
  const history = page.getByRole("region", { name: "Version history" });
  await expect(history.getByTestId("vault-version")).toHaveCount(1);
  await expect(history.getByRole("button", { name: "Restore" })).toHaveCount(0);

  await history.getByLabel("Version note").fill("Moved the date");
  await history.getByLabel("New version file").setInputFiles({ name: "dc7-plan.md", mimeType: "text/markdown", buffer: Buffer.from("# Plan\nShip on Friday.\nTell the team.\n") });
  await expect(history.getByTestId("vault-version")).toHaveCount(2);
  const newest = history.getByTestId("vault-version").first();
  const oldest = history.getByTestId("vault-version").last();
  await expect(newest).toContainText("v2");
  await expect(newest).toContainText("current");
  await expect(newest).toContainText("Moved the date");

  await oldest.getByRole("button", { name: "Compare with current" }).click();
  const comparison = history.getByRole("region", { name: /Changes from v1 to v2/ });
  await expect(comparison.getByTestId("diff-summary")).toHaveText("2 lines added, 1 line removed.");
  await expect(comparison.locator('tr[data-kind="remove"]')).toContainText("Ship on Monday.");
  await expect(comparison.locator('tr[data-kind="add"]').first()).toContainText("Ship on Friday.");
  await page.screenshot({ path: "../.artifacts/e2e/digital-vault-dc7-versions.png", fullPage: true });

  const download = page.waitForEvent("download");
  await oldest.getByRole("link", { name: "Download v1" }).click();
  expect((await download).suggestedFilename()).toBe("dc7-plan.md");

  await oldest.getByRole("button", { name: "Restore" }).click();
  await expect(history).toContainText("Restoring adds a copy as v3.");
  await history.getByRole("button", { name: "Confirm: make v1 current" }).click();
  await expect(history.getByTestId("vault-version")).toHaveCount(3);
  await expect(history.getByTestId("vault-version").first()).toContainText("Restored from version 1.");

  // The restore appended a version: the two earlier ones still hold their own bytes.
  const text = async (version?: number) => (await request.get(`/api/storage/entries/${entry.id}/download${version ? `?version=${version}` : ""}`)).text();
  expect(await text()).toBe("# Plan\nShip on Monday.\n");
  expect(await text(1)).toBe("# Plan\nShip on Monday.\n");
  expect(await text(2)).toBe("# Plan\nShip on Friday.\nTell the team.\n");
  expect(failedResponses).toEqual([]);
  expect(errors).toEqual([]);
});

test("engineering projects and the dashboard show what is really stored", async ({ page, request }) => {
  test.setTimeout(300_000);
  const errors = collectErrors(page);
  expect((await request.post("/api/ai/models/refresh")).ok()).toBe(true);
  expect((await request.patch("/api/ai/settings", { data: { default_model: "fake/fast", paused: false, daily_request_budget: 500 } })).ok()).toBe(true);

  // A real app with two finished versions, built by the fake engineers.
  const created = await request.post("/api/apps", { data: { description: REQUEST } });
  expect(created.ok()).toBe(true);
  const app = await created.json();
  await waitForApp(request, app.id, "awaiting_approval");
  expect((await request.post(`/api/apps/${app.id}/approve`)).ok()).toBe(true);
  await waitForApp(request, app.id, "ready");
  expect((await request.post(`/api/apps/${app.id}/changes`, { data: { request: "Add an About page." } })).ok()).toBe(true);
  await waitForApp(request, app.id, "awaiting_approval");
  expect((await request.post(`/api/apps/${app.id}/approve`)).ok()).toBe(true);
  await waitForApp(request, app.id, "ready");

  // Storing a finished version follows the build; wait until both versions are in the Vault.
  const stored = async () => (await request.get(`/api/storage/projects/${app.id}`)).json();
  await expect
    .poll(async () => (await stored()).versions.map((v: { files: unknown[]; stored_file_count: number }) => v.files.length > 0 && v.stored_file_count === v.files.length), { timeout: 30_000 })
    .toEqual([true, true]);
  const project = await stored();
  const second = project.versions[1];
  const modified = second.files.find((file: { change: string }) => file.change === "modified");
  const unchanged = second.files.filter((file: { change: string }) => file.change === "unchanged");
  expect(modified).toBeTruthy();
  expect(unchanged.length).toBeGreaterThan(0);

  await page.goto("/vault/projects");
  const list = page.getByRole("complementary", { name: "Engineering projects" });
  await list.locator(`[data-project-id="${app.id}"]`).click();
  await expect(list.locator(`[data-project-id="${app.id}"]`)).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 2, name: project.name })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open in Apps →" })).toHaveAttribute("href", `/apps/${app.id}`);
  await expect(page.getByRole("button", { name: /^Version 2/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("project-stored-count")).toContainText(`${second.files.length} of ${second.files.length} files stored`);
  await expect(page.getByTestId("project-file")).toHaveCount(second.files.length);
  await expect(page.getByTestId("project-file").filter({ hasText: "Unchanged" })).toHaveCount(unchanged.length);

  await page.getByTestId("project-file").filter({ hasText: modified.path }).getByRole("button", { name: modified.path }).click();
  const comparison = page.getByRole("region", { name: /Changes from Version 1 to Version 2/ });
  await expect(comparison.getByTestId("diff-summary")).toHaveText(/\d+ lines? added, \d+ lines? removed\./);
  await expect(comparison.locator('tr[data-kind="add"]').first()).toBeVisible();
  await page.getByRole("tab", { name: "Content" }).click();
  await expect(page.getByTestId("project-file-content")).not.toHaveText("Loading the stored file…");
  await page.getByRole("tab", { name: "Changes since version 1" }).click();
  await expect(comparison).toBeVisible();
  await page.screenshot({ path: "../.artifacts/e2e/digital-vault-dc7-projects.png", fullPage: true });

  const archive = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export version as ZIP" }).click();
  expect((await archive).suggestedFilename()).toBe("Version 2.zip");

  await page.getByRole("button", { name: /^Version 1/ }).click();
  await expect(page.getByTestId("project-file")).toHaveCount(project.versions[0].files.length);
  await expect(page.getByRole("columnheader", { name: /Since version/ })).toHaveCount(0);

  // The dashboard repeats the backend's own numbers.
  await page.getByRole("navigation", { name: "Vault sections" }).getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL(/\/vault\/dashboard$/);
  const tiles = page.getByTestId("dashboard-tile");
  await expect(tiles).toHaveCount(6);
  const board = await (await request.get("/api/storage/dashboard")).json();
  const tile = (label: string) => page.locator(`[data-testid="dashboard-tile"][data-label="${label}"] p`).nth(1);
  await expect(tile("Files")).toHaveText(String(board.totals.files));
  await expect(tile("Versions")).toHaveText(String(board.totals.versions));
  await expect(tile("Failed registrations")).toHaveText(String(board.totals.registration_failures));
  await expect(page.getByTestId("activity-day")).toHaveCount(14);
  await expect(page.getByTestId("dashboard-projects")).toContainText(`${board.projects.ready_versions} finished version`);
  await expect(page.getByTestId("dashboard-workspace").filter({ hasText: "Software Engineering" })).toBeVisible();
  await expect(page.getByTestId("dashboard-type").filter({ hasText: "App source" })).toBeVisible();
  await expect(page.getByTestId("dashboard-event").first()).toBeVisible();
  await page.getByTestId("activity-day").last().hover();
  await expect(page.getByTestId("activity-day").last()).toContainText(/\d+ events?/);
  await page.screenshot({ path: "../.artifacts/e2e/digital-vault-dc7-dashboard.png", fullPage: true });
  expect(errors).toEqual([]);
});
