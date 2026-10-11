import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BackupStatus, IntegrityReport, StorageEntryDetail, StorageGrantDetail } from "@/lib/storage";

import { ProtectionPage } from "./ProtectionPage";
import { SharePanel } from "./SharePanel";

vi.mock("next/navigation", () => ({ usePathname: () => "/vault/protection" }));
vi.mock("@/world/state/employeeStore", () => ({ startRosterSync: vi.fn() }));

const at = "2026-10-11T09:00:00Z";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const snapshot = { id: "bkp_20261011T090000000000Z_aaaaaaaa", created_at: at, status: "complete" as const, files: 4, versions: 6, bytes: 2048, skipped_versions: 0, verified_at: null, verified_ok: null };
const configured: BackupStatus = { configured: true, same_device: true, keep: 7, last_backup_at: at, snapshots: [snapshot, { ...snapshot, id: "bkp_20261010T090000000000Z_bbbbbbbb", status: "partial", skipped_versions: 2, verified_at: at, verified_ok: false }] };
const unconfigured: BackupStatus = { configured: false, same_device: null, keep: 7, last_backup_at: null, snapshots: [] };
const healthy: IntegrityReport = { last_check: null, damaged_total: 0, damaged: [] };
const damaged: IntegrityReport = {
  last_check: { at, checked: 6, missing: 1, corrupt: 1, recovered: 0, orphaned: 3, unsafe: 0 },
  damaged_total: 2,
  damaged: [
    { entry_id: "ste_a", workspace_id: "ws_department:engineering", name: "plan.txt", path: "Plans/plan.txt", version: 2, is_current: true, status: "missing", size_bytes: 120 },
    { entry_id: "ste_b", workspace_id: "ws_company", name: "budget.csv", path: "budget.csv", version: 1, is_current: false, status: "quarantined", size_bytes: 64 },
  ],
};
const grant: StorageGrantDetail = { id: "stg_1", workspace_id: "ws_department:engineering", entry_id: "ste_plans", grantee_kind: "department", grantee_id: "marketing", permission: "read", expires_at: null, revoked_at: null, created_at: at, grantee_name: "Marketing", entry_name: "Plans", entry_path: "Plans", entry_kind: "folder", inherited: false };

type Handler = (url: string, init?: RequestInit) => Response | undefined;

function stub(handler: Handler) {
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const response = handler(String(input), init);
    if (!response) throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${String(input)}`);
    return response;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const posted = (mock: ReturnType<typeof stub>, path: string) => mock.mock.calls.filter(([url, init]) => String(url) === path && init?.method === "POST");

describe("ProtectionPage", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("says plainly that nothing is protected when backups are not configured", async () => {
    stub((url) => {
      if (url === "/api/storage/backups") return json(unconfigured);
      if (url === "/api/storage/maintenance/integrity") return json(healthy);
      if (url === "/api/storage/grants") return json([]);
    });
    render(<ProtectionPage />);

    expect(await screen.findByTestId("backup-unconfigured")).toHaveTextContent("NEXUS_STORAGE_BACKUP_ROOT");
    expect(screen.getByRole("button", { name: "Back up now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Repair from backup" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove unused objects" })).toBeDisabled();
    const tiles = Object.fromEntries(screen.getAllByTestId("protection-tile").map((tile) => [tile.dataset.label, tile.textContent]));
    expect(tiles["Last backup"]).toContain("Not configured");
    expect(tiles["Integrity check"]).toContain("Never");
    expect(tiles["Damaged versions"]).toContain("0");
    expect(screen.getByText("No damaged versions are known.")).toBeInTheDocument();
    expect(screen.getByText("Nothing is shared outside its own department.")).toBeInTheDocument();
    expect(screen.getByTestId("integrity-last-check")).toHaveTextContent("No integrity check has been run yet.");
  });

  it("backs up, verifies, repairs, cleans up after confirmation, recovers a deleted file and revokes a grant", async () => {
    const mock = stub((url, init) => {
      const method = init?.method ?? "GET";
      if (url === "/api/storage/backups" && method === "GET") return json(configured);
      if (url === "/api/storage/backups" && method === "POST") return json({ ...snapshot, id: "bkp_20261011T100000000000Z_cccccccc", versions: 6, skipped_versions: 1, status: "partial" }, 201);
      if (url === "/api/storage/maintenance/integrity") return json(damaged);
      if (url === "/api/storage/grants") return json([grant]);
      if (url === `/api/storage/backups/${snapshot.id}/verify`) return json({ id: snapshot.id, healthy: true, manifest_ok: true, checked: 5, ok: 5, missing: 0, corrupt: 0, verified_at: at });
      if (url === "/api/storage/maintenance/reconcile") return json({ checked: 6, missing: 1, corrupt: 1, recovered: 0, orphaned: 3, unsafe: 0 });
      if (url === "/api/storage/maintenance/repair") return json({ examined: 2, repaired: 1, not_in_backup: 1, failed: 0 });
      if (url === "/api/storage/maintenance/cleanup") return json({ removed_objects: 3, removed_bytes: 4096, removed_temporary: 1, kept_recent: 2, unsafe: 0 });
      if (url === `/api/storage/backups/${snapshot.id}/deleted`) return json({ id: snapshot.id, total: 3, items: [
        { entry_id: "ste_gone", workspace_id: "ws_department:marketing", name: "report.txt", path: "Reports/report.txt", version: 1, size_bytes: 19, recoverable: true, present_at: null },
        { entry_id: "ste_back", workspace_id: "ws_company", name: "back.txt", path: "back.txt", version: 1, size_bytes: 7, recoverable: true, present_at: "Recovered from backup/back.txt" },
        { entry_id: "ste_lost", workspace_id: "ws_company", name: "lost.txt", path: "lost.txt", version: 1, size_bytes: 5, recoverable: false, present_at: null },
      ] });
      if (url === `/api/storage/backups/${snapshot.id}/recover`) return json({ id: "ste_new", workspace_id: "ws_department:marketing", path: "Recovered from backup/report.txt" }, 201);
      if (url === "/api/storage/grants/stg_1" && method === "DELETE") return json(grant);
    });
    render(<ProtectionPage />);

    // State is shown in words, not only colour.
    const rows = await screen.findAllByTestId("backup-snapshot");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Complete");
    expect(rows[0]).toHaveTextContent("4 files · 6 versions · 2.0 KiB · Not verified yet");
    expect(rows[1]).toHaveTextContent("Partial — 2 versions not saved");
    expect(rows[1]).toHaveTextContent("Failed verification");
    expect(screen.getByTestId("backup-same-drive")).toHaveTextContent("same drive");
    const broken = screen.getAllByTestId("damaged-version");
    expect(broken[0]).toHaveTextContent("plan.txt · version 2 (current)");
    expect(broken[0]).toHaveTextContent("Missing");
    expect(broken[1]).toHaveTextContent("Corrupt");
    expect(screen.getByTestId("integrity-last-check")).toHaveTextContent("6 versions compared with stored bytes — 1 missing, 1 corrupt, 3 stored objects that no file refers to.");

    const notice = async (text: string | RegExp) => await waitFor(() => expect(screen.getByTestId("protection-notice")).toHaveTextContent(text));

    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    await notice("Backup partial: 5 of 6 versions saved.");

    fireEvent.click(within(screen.getAllByTestId("backup-snapshot")[0]!).getByRole("button", { name: "Verify" }));
    await notice("Backup verified: all 5 stored objects match their checksums.");

    fireEvent.click(screen.getByRole("button", { name: "Check integrity now" }));
    await notice("Checked 6 versions: 1 missing, 1 corrupt, 3 unused objects.");

    fireEvent.click(screen.getByRole("button", { name: "Repair from backup" }));
    await notice("Repaired 1 of 2 damaged versions; 1 is not in any backup.");

    // Removing objects is permanent, so the first click only asks.
    fireEvent.click(screen.getByRole("button", { name: "Remove unused objects" }));
    expect(posted(mock, "/api/storage/maintenance/cleanup")).toHaveLength(0);
    expect(screen.getByText(/removed permanently/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm: remove unused objects" }));
    await notice("Removed 3 unused objects (4.0 KiB) and 1 upload fragment; 2 written in the last hour were left alone.");
    expect(posted(mock, "/api/storage/maintenance/cleanup")[0]![1]!.body).toBe(JSON.stringify({ confirm: true }));

    fireEvent.click(within(screen.getAllByTestId("backup-snapshot")[0]!).getByRole("button", { name: "Deleted files" }));
    const gone = await screen.findAllByTestId("deleted-file");
    expect(gone[0]).toHaveTextContent("Marketing · Reports/report.txt · 19 B");
    expect(gone[1]).toHaveTextContent("In the Vault as Recovered from backup/back.txt");
    expect(within(gone[1]!).queryByRole("button")).toBeNull();
    expect(gone[2]).toHaveTextContent("Content was not saved");
    expect(within(gone[2]!).queryByRole("button")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Recover report.txt" }));
    await notice("Recovered report.txt to “Recovered from backup/report.txt” in Marketing.");
    expect(posted(mock, `/api/storage/backups/${snapshot.id}/recover`)[0]![1]!.body).toBe(JSON.stringify({ entry_id: "ste_gone" }));

    const shared = screen.getByTestId("sharing-grant");
    expect(shared).toHaveTextContent("Plans → Marketing (department)");
    expect(shared).toHaveTextContent("Engineering · Plans · can read · no expiry");
    fireEvent.click(screen.getByRole("button", { name: "Revoke access of Marketing" }));
    await notice("Marketing no longer has access to Plans.");
  });

  it("shows a backend refusal instead of pretending the backup worked", async () => {
    stub((url, init) => {
      if (url === "/api/storage/backups" && init?.method === "POST") return json({ detail: "Another backup operation is already running." }, 409);
      if (url === "/api/storage/backups") return json({ ...configured, same_device: false });
      if (url === "/api/storage/maintenance/integrity") return json(healthy);
      if (url === "/api/storage/grants") return json([]);
    });
    render(<ProtectionPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Another backup operation is already running.");
    expect(screen.queryByTestId("protection-notice")).toBeNull();
    expect(screen.queryByTestId("backup-same-drive")).toBeNull();
  });
});

describe("SharePanel", () => {
  const detail = {
    id: "ste_plan",
    workspace_id: "ws_department:engineering",
    kind: "file",
    name: "plan.txt",
    path: "Plans/plan.txt",
    trashed_at: null,
  } as StorageEntryDetail;

  beforeEach(() => vi.unstubAllGlobals());

  it("lists who can reach an item and shares it with an expiry", async () => {
    const mock = stub((url, init) => {
      if (url === "/api/storage/grants?entry_id=ste_plan") {
        return json([
          { ...grant, id: "stg_folder", inherited: true },
          { ...grant, id: "stg_direct", entry_id: "ste_plan", entry_name: "plan.txt", grantee_kind: "employee", grantee_id: "emp_1", grantee_name: "Iris Wong", permission: "write", expires_at: "2026-10-18T09:00:00Z" },
        ]);
      }
      if (url === "/api/departments") return json([{ key: "engineering", name: "Software Engineering" }, { key: "marketing", name: "Marketing" }, { key: "sales", name: "Sales" }]);
      if (url === "/api/employees") return json([{ id: "emp_1", name: "Iris Wong", role: "Analyst", department: "research" }, { id: "emp_2", name: "Yusuf Demir", role: "Backend Developer", department: "engineering" }]);
      if (url === "/api/storage/workspaces/ws_department%3Aengineering/grants" && init?.method === "POST") return json({ ...grant, id: "stg_new" }, 201);
      if (url === "/api/storage/grants/stg_direct" && init?.method === "DELETE") return json(grant);
    });
    const actions: Promise<unknown>[] = [];
    const onAction = (action: () => Promise<unknown>) => void actions.push(action());
    render(<SharePanel detail={detail} busy={false} onAction={onAction} />);

    const rows = await screen.findAllByTestId("item-grant");
    expect(rows[0]).toHaveTextContent("Marketing · can read");
    expect(rows[0]).toHaveTextContent("through the folder Plans · no expiry");
    expect(within(rows[0]!).queryByRole("button")).toBeNull(); // revoked where it was granted
    expect(rows[1]).toHaveTextContent("Iris Wong · can read and change");
    expect(rows[1]).toHaveTextContent("shared directly · until");

    // The owning department is not offered: it already has access.
    const who = screen.getByLabelText("Share with");
    await waitFor(() => expect(within(who).getByRole("option", { name: "Sales" })).toBeInTheDocument());
    expect(within(who).queryByRole("option", { name: "Software Engineering" })).toBeNull();
    expect(screen.getByRole("button", { name: "Share" })).toBeDisabled();

    fireEvent.change(who, { target: { value: "sales" } });
    fireEvent.change(screen.getByLabelText("Access duration"), { target: { value: "7" } });
    const before = Date.now();
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await Promise.all(actions);
    const body = JSON.parse(String(posted(mock, "/api/storage/workspaces/ws_department%3Aengineering/grants")[0]![1]!.body));
    expect(body).toMatchObject({ grantee_kind: "department", grantee_id: "sales", permission: "read", entry_id: "ste_plan" });
    const days = (new Date(body.expires_at).getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);

    fireEvent.change(screen.getByLabelText("Share with a department or an employee"), { target: { value: "employee" } });
    expect(within(who).getByRole("option", { name: "Iris Wong — Analyst" })).toBeInTheDocument();
    expect(within(who).queryByRole("option", { name: /Yusuf Demir/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Revoke access of Iris Wong" }));
    await waitFor(() => expect(mock.mock.calls.some(([url, init]) => String(url) === "/api/storage/grants/stg_direct" && init?.method === "DELETE")).toBe(true));
  });

  it("offers no sharing form for an item in Trash", async () => {
    stub((url) => {
      if (url === "/api/storage/grants?entry_id=ste_plan") return json([]);
      if (url === "/api/departments" || url === "/api/employees") return json([]);
    });
    render(<SharePanel detail={{ ...detail, trashed_at: at }} busy={false} onAction={vi.fn()} />);
    expect(await screen.findByText("Only this department can open it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
  });
});
