import { expect, test } from "@playwright/test";

import { collectErrors } from "./helpers";

test("the Digital Vault completes the core browser workflow", async ({ page, request }) => {
  const errors = collectErrors(page);
  const failedResponses: string[] = [];
  page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });
  const itemNamed = (name: string) => page.getByTestId("vault-item").filter({ has: page.getByText(name, { exact: true }) });
  const vaultNavigation = page.getByRole("complementary", { name: "Vault navigation" });
  const workspaceId = "ws_company";
  const folderName = "DC5 Release";

  const folderResponse = await request.post(`/api/storage/workspaces/${workspaceId}/folders`, {
    data: { name: folderName, parent_id: null },
  });
  expect(folderResponse.ok()).toBe(true);
  const folder = await folderResponse.json();

  const uploadResponse = await request.post(`/api/storage/workspaces/${workspaceId}/files`, {
    multipart: {
      parent_id: folder.id,
      description: "Browser acceptance artifact",
      file: { name: "dc5-notes.md", mimeType: "text/markdown", buffer: Buffer.from("# DC-5\nVault browser acceptance.") },
    },
  });
  expect(uploadResponse.ok()).toBe(true);

  await page.goto("/vault");
  await expect(page.getByRole("heading", { name: "Digital Vault" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Company Vault" })).toBeVisible();
  await page.getByRole("button", { name: `Open folder ${folderName}` }).click();
  await expect(itemNamed("dc5-notes.md")).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: "ui-upload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Uploaded from the Vault browser."),
  });
  await expect(itemNamed("ui-upload.txt")).toBeVisible();

  await itemNamed("dc5-notes.md").getByText("dc5-notes.md", { exact: true }).click();
  await expect(page.getByText(/Vault browser acceptance/)).toBeVisible();
  await expect(page.getByLabel("Description")).toHaveValue("Browser acceptance artifact");

  await page.getByLabel("Item name").fill("launch-notes.md");
  await page.getByLabel("Description").fill("Approved launch notes");
  await page.getByLabel("Tags").fill("release, dc5");
  await page.getByRole("button", { name: "Save metadata" }).click();
  await expect(page.getByRole("heading", { name: "launch-notes.md" })).toBeVisible();
  await expect(page.getByLabel("Description")).toHaveValue("Approved launch notes");

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download" }).click();
  expect((await download).suggestedFilename()).toBe("launch-notes.md");

  await page.getByRole("button", { name: "Favorite", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unfavorite" })).toBeVisible();
  await page.getByRole("button", { name: "Favorites" }).click();
  await expect(itemNamed("launch-notes.md")).toBeVisible();

  await page.getByPlaceholder(/Search names/).fill("launch");
  await expect(itemNamed("launch-notes.md")).toBeVisible();
  await page.getByRole("button", { name: "List" }).click();
  await expect(page.getByRole("columnheader", { name: "Updated" })).toBeVisible();
  await page.getByRole("button", { name: "Grid" }).click();

  await itemNamed("launch-notes.md").getByText("launch-notes.md", { exact: true }).click();
  const archive = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export ZIP" }).click();
  expect((await archive).suggestedFilename()).toBe("launch-notes.md.zip");

  await page.getByRole("button", { name: "Duplicate" }).click();
  await expect(itemNamed("launch-notes copy.md")).toBeVisible();

  await itemNamed("launch-notes.md").getByText("launch-notes.md", { exact: true }).click();
  await page.getByRole("button", { name: "Move to Trash" }).click();
  await page.getByRole("button", { name: "Confirm move to Trash" }).click();
  await vaultNavigation.getByRole("button", { name: /Trash/ }).click();
  await itemNamed("launch-notes.md").getByText("launch-notes.md", { exact: true }).click();
  await page.getByRole("button", { name: "Restore" }).click();

  await page.getByRole("button", { name: "All files" }).click();
  await page.getByPlaceholder(/Search names/).fill("launch-notes.md");
  await expect(itemNamed("launch-notes.md")).toBeVisible();
  await itemNamed("launch-notes.md").getByText("launch-notes.md", { exact: true }).click();
  await page.getByRole("button", { name: "Move to Trash" }).click();
  await page.getByRole("button", { name: "Confirm move to Trash" }).click();
  await vaultNavigation.getByRole("button", { name: /Trash/ }).click();
  await itemNamed("launch-notes.md").getByText("launch-notes.md", { exact: true }).click();
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await page.getByRole("button", { name: "Confirm permanent delete" }).click();
  await expect(itemNamed("launch-notes.md")).toHaveCount(0);

  await page.getByRole("button", { name: "All files" }).click();
  await page.getByRole("button", { name: "+ New folder" }).click();
  await page.getByLabel("New folder name").fill("Review Queue");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(itemNamed("Review Queue")).toBeVisible();

  await page.screenshot({ path: "../.artifacts/e2e/digital-vault-dc5.png", fullPage: true });
  expect(failedResponses).toEqual([]);
  expect(errors).toEqual([]);
});

test("completed employee work appears automatically in the AI-generated view", async ({ page, request }) => {
  const errors = collectErrors(page);
  expect((await request.post("/api/ai/models/refresh")).ok()).toBe(true);
  expect((await request.patch("/api/ai/settings", {
    data: { default_model: "fake/fast", paused: false, daily_request_budget: 500 },
  })).ok()).toBe(true);
  const created = await request.post("/api/tasks", {
    data: {
      title: "DC6 launch brief",
      description: "Write the launch brief as a durable deliverable.",
      department: "marketing",
      run: true,
    },
  });
  expect(created.ok()).toBe(true);
  const task = await created.json();

  await expect.poll(async () => {
    const response = await request.get("/api/tasks");
    const tasks = await response.json();
    return tasks.find((item: { id: string }) => item.id === task.id)?.status;
  }).toBe("done");

  await page.goto("/vault");
  const navigation = page.getByRole("complementary", { name: "Vault navigation" });
  await navigation.getByRole("button", { name: /^Marketing/ }).click();
  await navigation.getByRole("button", { name: /AI generated/ }).click();
  const artifact = page.getByTestId("vault-item").filter({ hasText: "DC6 launch brief" });
  await expect(artifact).toBeVisible();
  await artifact.getByText(/DC6 launch brief/).click();
  await expect(page.getByText("task · DC6 launch brief")).toBeVisible();
  await expect(page.getByText(/three concrete steps/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload file" })).toBeDisabled();
  await page.screenshot({ path: "../.artifacts/e2e/digital-vault-dc6-generated.png", fullPage: true });
  expect(errors).toEqual([]);
});
