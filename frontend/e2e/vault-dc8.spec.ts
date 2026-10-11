import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { collectErrors } from "./helpers";

// The same private folder playwright.config.ts gives the test backend.
const STORAGE = `/tmp/nexus-e2e-storage-${Number(process.env.E2E_API_PORT ?? 18200)}`;

async function upload(request: APIRequestContext, workspace: string, name: string, content: string) {
  const response = await request.post(`/api/storage/workspaces/${workspace}/files`, {
    multipart: { file: { name, mimeType: "text/markdown", buffer: Buffer.from(content) } },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { id: string };
}

/** Deletes the stored bytes of a file behind the Vault's back, as a failing disk would. */
function loseStoredContent(content: string): number {
  let removed = 0;
  for (const folder of readdirSync(join(STORAGE, "objects"))) {
    for (const name of readdirSync(join(STORAGE, "objects", folder))) {
      const path = join(STORAGE, "objects", folder, name);
      if (readFileSync(path, "utf8") === content) {
        unlinkSync(path);
        removed += 1;
      }
    }
  }
  return removed;
}

const notice = (page: Page) => page.getByTestId("protection-notice");

test("back up the Vault, repair a lost file from the backup and recover a deleted one", async ({ page, request }) => {
  const errors = collectErrors(page);
  const failedResponses: string[] = [];
  page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });
  const kept = "# DC-8 kept\nThis file loses its stored bytes.\n";
  const gone = "# DC-8 gone\nThis file is deleted for good.\n";
  const keptEntry = await upload(request, "ws_company", "dc8-kept.md", kept);
  const goneEntry = await upload(request, "ws_company", "dc8-gone.md", gone);

  await page.goto("/vault/protection");
  await expect(page.getByRole("navigation", { name: "Vault sections" }).getByRole("link", { name: "Protection" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("protection-tile")).toHaveCount(4);
  await expect(page.getByTestId("backup-snapshot")).toHaveCount(0);
  await expect(page.getByText("No backup has been taken yet.")).toBeVisible();

  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(notice(page)).toContainText(/Backup complete: \d+ of \d+ versions? saved\./);
  const snapshot = page.getByTestId("backup-snapshot").first();
  await expect(snapshot).toContainText("Complete");
  await expect(snapshot).toContainText("Not verified yet");
  // The page shows what the backend reports, including the same-drive warning in this test setup.
  const status = await (await request.get("/api/storage/backups")).json();
  expect(status.snapshots).toHaveLength(1);
  await expect(page.getByTestId("backup-same-drive")).toHaveCount(status.same_device ? 1 : 0);

  await snapshot.getByRole("button", { name: "Verify" }).click();
  await expect(notice(page)).toContainText(/Backup verified: all \d+ stored objects? match their checksums\./);
  await expect(page.getByTestId("backup-snapshot").first()).toContainText("Verified");

  // The disk loses one file's bytes: the Vault notices, says so, and puts them back.
  expect(loseStoredContent(kept)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Check integrity now" }).click();
  await expect(notice(page)).toContainText(/Checked \d+ versions?: 1 missing, 0 corrupt/);
  const damaged = page.getByTestId("damaged-version");
  await expect(damaged).toHaveCount(1);
  await expect(damaged).toContainText("dc8-kept.md");
  await expect(damaged).toContainText("Missing");
  await expect(page.locator('[data-testid="protection-tile"][data-label="Damaged versions"]')).toContainText("1");
  expect((await request.get(`/api/storage/entries/${keptEntry.id}/download`)).status()).toBe(409);
  await page.screenshot({ path: "../.artifacts/e2e/digital-vault-dc8-damaged.png", fullPage: true });

  await page.getByRole("button", { name: "Repair from backup" }).click();
  await expect(notice(page)).toContainText("Repaired 1 of 1 damaged version.");
  await expect(page.getByText("No damaged versions are known.")).toBeVisible();
  await expect(page.getByTestId("integrity-last-check")).toContainText("1 damaged version has since been repaired or removed.");
  expect(await (await request.get(`/api/storage/entries/${keptEntry.id}/download`)).text()).toBe(kept);

  // A permanently deleted file is still in the backup and comes back as a new file.
  expect((await request.delete(`/api/storage/entries/${goneEntry.id}`)).ok()).toBe(true);
  expect((await request.delete(`/api/storage/entries/${goneEntry.id}/permanent?confirm=true`)).ok()).toBe(true);
  await page.getByTestId("backup-snapshot").first().getByRole("button", { name: "Deleted files" }).click();
  const deleted = page.getByTestId("deleted-file");
  await expect(deleted).toHaveCount(1);
  await expect(deleted).toContainText("dc8-gone.md");
  await page.getByRole("button", { name: "Recover dc8-gone.md" }).click();
  await expect(notice(page)).toContainText("Recovered dc8-gone.md to “Recovered from backup/dc8-gone.md” in Company Vault.");
  const found = await (await request.get("/api/storage/search?workspace_id=ws_company&q=dc8-gone.md&kind=file")).json();
  expect(found.total).toBe(1);
  expect(found.items[0].path).toBe("Recovered from backup/dc8-gone.md");
  expect(await (await request.get(`/api/storage/entries/${found.items[0].id}/download`)).text()).toBe(gone);
  // It is no longer offered for recovery: the list says where the content now is.
  await expect(deleted).toContainText("In the Vault as Recovered from backup/dc8-gone.md");
  await expect(deleted.getByRole("button")).toHaveCount(0);

  await page.screenshot({ path: "../.artifacts/e2e/digital-vault-dc8-protection.png", fullPage: true });
  // The one refused download above was requested by the test itself, not by the page.
  expect(failedResponses).toEqual([]);
  expect(errors).toEqual([]);
});

test("share a folder with another department, find it under Shared and revoke it", async ({ page, request }) => {
  const errors = collectErrors(page);
  const created = await request.post("/api/storage/workspaces/ws_department:engineering/folders", { data: { name: "DC8 Shared", parent_id: null } });
  expect(created.ok()).toBe(true);
  const folder = await created.json();

  await page.goto("/vault");
  const navigation = page.getByRole("complementary", { name: "Vault navigation" });
  await navigation.getByRole("button", { name: /^Engineering/ }).click();
  await page.getByTestId("vault-item").filter({ has: page.getByText("DC8 Shared", { exact: true }) }).getByText("DC8 Shared", { exact: true }).first().click();
  const sharing = page.getByRole("region", { name: "Sharing" });
  await expect(sharing).toContainText("Only this department can open it.");
  await expect(sharing.getByLabel("Share with", { exact: true }).getByRole("option", { name: "Software Engineering" })).toHaveCount(0);

  await sharing.getByLabel("Share with", { exact: true }).selectOption({ label: "Marketing" });
  await sharing.getByLabel("Access duration").selectOption({ label: "For 7 days" });
  await sharing.getByRole("button", { name: "Share" }).click();
  const grant = sharing.getByTestId("item-grant");
  await expect(grant).toHaveCount(1);
  await expect(grant).toContainText("Marketing · can read");
  await expect(grant).toContainText("shared directly · until");

  // The backend, not the page, decides who may read it.
  const grants = await (await request.get(`/api/storage/grants?entry_id=${folder.id}`)).json();
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({ grantee_kind: "department", grantee_id: "marketing", permission: "read", inherited: false });
  expect(new Date(grants[0].expires_at).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

  await navigation.getByRole("button", { name: /Shared/ }).click();
  await expect(page.getByTestId("vault-item")).toHaveCount(1);
  await expect(page.getByTestId("vault-item")).toContainText("DC8 Shared");
  await page.getByTestId("vault-item").getByText("DC8 Shared", { exact: true }).first().click();
  await expect(page.getByRole("region", { name: "Sharing" }).getByTestId("item-grant")).toHaveCount(1);
  await page.getByRole("region", { name: "Sharing" }).getByRole("button", { name: "Share" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "../.artifacts/e2e/digital-vault-dc8-sharing.png", fullPage: true });

  await page.goto("/vault/protection");
  const row = page.getByTestId("sharing-grant").filter({ hasText: "DC8 Shared" });
  await expect(row).toContainText("DC8 Shared → Marketing (department)");
  await expect(row).toContainText("can read · until");
  await row.getByRole("button", { name: "Revoke access of Marketing" }).click();
  await expect(notice(page)).toContainText("Marketing no longer has access to DC8 Shared.");
  await expect(page.getByTestId("sharing-grant").filter({ hasText: "DC8 Shared" })).toHaveCount(0);
  expect(await (await request.get(`/api/storage/grants?entry_id=${folder.id}`)).json()).toEqual([]);
  expect(errors).toEqual([]);
});
