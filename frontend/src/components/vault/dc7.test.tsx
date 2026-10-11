import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StorageDashboard, StorageDiff, StorageEntryDetail, StorageProjectDetail } from "@/lib/storage";

import { DiffView, diffSummary } from "./DiffView";
import { ProjectsPage } from "./ProjectsPage";
import { VaultDashboard } from "./VaultDashboard";
import { VersionHistory } from "./VersionHistory";

vi.mock("next/navigation", () => ({ usePathname: () => "/vault/projects" }));
vi.mock("@/world/state/employeeStore", () => ({ startRosterSync: vi.fn() }));

const at = "2026-10-09T08:30:00Z";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const side = { entry_id: "ste_a", name: "notes.txt", path: "notes.txt", version: 1, size_bytes: 18, sha256: "a".repeat(64), created_by_name: "Owner", created_at: at };
const diff: StorageDiff = {
  before: side,
  after: { ...side, version: 2, size_bytes: 27, sha256: "b".repeat(64) },
  identical: false,
  comparable: true,
  reason: null,
  line_endings_only: false,
  added: 2,
  removed: 1,
  truncated: false,
  lines: [
    { kind: "hunk", old: null, new: null, text: "@@ -1,2 +1,3 @@" },
    { kind: "context", old: 1, new: 1, text: "line one" },
    { kind: "remove", old: 2, new: null, text: "line two" },
    { kind: "add", old: null, new: 2, text: "line 2" },
    { kind: "add", old: null, new: 3, text: "line three" },
  ],
};

function version(number: number, current: boolean, note: string | null = null) {
  return { id: `stv_${number}`, number, mime_type: "text/plain", size_bytes: 10 + number, sha256: String(number).repeat(64), status: "available" as const, is_current: current, change_description: note, created_by_kind: "owner" as const, created_by_name: "Owner", created_at: at };
}

const detail: StorageEntryDetail = {
  id: "ste_a",
  workspace_id: "ws_company",
  parent_id: null,
  kind: "file",
  name: "notes.txt",
  path: "notes.txt",
  description: null,
  status: "available",
  current_version_number: 2,
  size_bytes: 12,
  mime_type: "text/plain",
  sha256: "2".repeat(64),
  tags: [],
  favorite: false,
  preview_kind: "text",
  trashed_at: null,
  created_at: at,
  updated_at: at,
  original_name: "notes.txt",
  artifact_type: null,
  visibility: "company",
  created_by_kind: "owner",
  created_by_employee_id: null,
  created_by_name: "Owner",
  owner_kind: "company",
  owner_id: "company",
  owner_name: "NEXUS AI",
  source_managed: false,
  versions: [version(2, true, "Second draft"), version(1, false)],
  links: [],
  events: [],
};

describe("diffSummary", () => {
  it("says in words what the comparison found", () => {
    expect(diffSummary(diff)).toBe("2 lines added, 1 line removed.");
    expect(diffSummary({ ...diff, identical: true })).toBe("These two versions are identical.");
    expect(diffSummary({ ...diff, comparable: false, reason: "Only text files can be compared line by line." })).toBe("Only text files can be compared line by line.");
    expect(diffSummary({ ...diff, added: 0, removed: 0, line_endings_only: true })).toBe("Only line endings or the final newline differ.");
  });
});

describe("DiffView", () => {
  it("shows the backend's line comparison with line numbers and marks", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(diff)));
    render(<DiffView request={{ beforeEntry: "ste_a", beforeVersion: 1, afterEntry: "ste_a", afterVersion: 2 }} beforeLabel="v1" afterLabel="v2" />);
    expect(await screen.findByTestId("diff-summary")).toHaveTextContent("2 lines added, 1 line removed.");
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe("/api/storage/diff?before_entry=ste_a&after_entry=ste_a&before_version=1&after_version=2");
    const removed = screen.getByText("line two").closest("tr")!;
    expect(removed).toHaveAttribute("data-kind", "remove");
    expect(within(removed).getByLabelText("removed")).toHaveTextContent("−");
    expect(screen.getByText("line three").closest("tr")).toHaveAttribute("data-kind", "add");
  });

  it("explains why two versions cannot be compared instead of showing an empty result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...diff, comparable: false, reason: "Only text files can be compared line by line.", added: 0, removed: 0, lines: [] })));
    render(<DiffView request={{ beforeEntry: "ste_a", afterEntry: "ste_b" }} beforeLabel="Version 1" afterLabel="Version 2" />);
    expect(await screen.findByTestId("diff-summary")).toHaveTextContent("Only text files can be compared line by line.");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("VersionHistory", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("/api/storage/diff?")) return json(diff);
      if (url.endsWith("/versions/1/restore")) return json({}, 201);
      throw new Error(`Unexpected request: ${url}`);
    }));
  });

  it("lists every version, compares an older one and restores it only after a second click", async () => {
    const onAction = vi.fn((action: () => Promise<unknown>) => void action());
    render(<VersionHistory detail={detail} busy={false} onAction={onAction} />);
    const rows = screen.getAllByTestId("vault-version");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("current")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Second draft")).toBeInTheDocument();
    expect(within(rows[0]!).queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    expect(within(rows[1]!).getByRole("link", { name: "Download v1" })).toHaveAttribute("href", "/api/storage/entries/ste_a/download?version=1");

    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Compare with current" }));
    expect(await screen.findByTestId("diff-summary")).toHaveTextContent("2 lines added");

    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Restore" }));
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByText(/Restoring adds a copy as v3/)).toBeInTheDocument();
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Confirm: make v1 current" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).endsWith("/entries/ste_a/versions/1/restore") && init?.method === "POST")).toBe(true));
  });

  it("uploads a new version with its note", async () => {
    const calls: { url: string; body: FormData }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body as FormData });
      return json({}, 201);
    }));
    render(<VersionHistory detail={detail} busy={false} onAction={(action) => void action()} />);
    fireEvent.change(screen.getByLabelText("Version note"), { target: { value: "Third draft" } });
    const input = screen.getByLabelText("New version file");
    expect(input).toHaveAttribute("accept", ".txt");
    fireEvent.change(input, { target: { files: [new File(["new text"], "notes.txt", { type: "text/plain" })] } });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe("/api/storage/entries/ste_a/versions");
    expect(calls[0]!.body.get("change_description")).toBe("Third draft");
    expect((calls[0]!.body.get("file") as File).name).toBe("notes.txt");
  });

  it("keeps a mirrored employee artifact read-only and says why", () => {
    render(<VersionHistory detail={{ ...detail, source_managed: true }} busy={false} onAction={vi.fn()} />);
    expect(screen.getByText(/mirrors real employee work/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload new version" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare with current" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download v1" })).toBeInTheDocument();
  });
});

const emptyBoard: StorageDashboard = {
  generated_at: at,
  utc_offset_minutes: 0,
  totals: { files: 0, folders: 0, trashed: 0, versions: 0, stored_bytes: 0, unavailable_files: 0, error_events: 0, registration_failures: 0 },
  workspaces: [{ id: "ws_company", scope: "company", department_key: null, state: "active", used_bytes: 0, quota_bytes: 1024, quota_override_bytes: null, name: "Company Vault", file_count: 0 }],
  by_type: [],
  by_creator: [],
  top_creators: [],
  activity: Array.from({ length: 14 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, "0")}`, events: 0, errors: 0 })),
  recent_events: [],
  projects: { apps: 0, ready_versions: 0, stored_files: 0 },
};

describe("VaultDashboard", () => {
  it("says there is not enough data instead of drawing empty charts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(emptyBoard)));
    render(<VaultDashboard />);
    expect(await screen.findByText(/no workspace holds a file yet/)).toBeInTheDocument();
    expect(screen.getByText(/no storage activity was recorded in the last 14 days/)).toBeInTheDocument();
    expect(screen.getByText(/no employee work has been stored yet/)).toBeInTheDocument();
    expect(screen.queryByTestId("activity-day")).not.toBeInTheDocument();
    expect(screen.getByText("1 other workspace holds no files.")).toBeInTheDocument();
  });

  it("shows the real totals, usage, types, activity and failures", async () => {
    const board: StorageDashboard = {
      ...emptyBoard,
      totals: { files: 3, folders: 2, trashed: 1, versions: 5, stored_bytes: 2048, unavailable_files: 0, error_events: 1, registration_failures: 1 },
      workspaces: [
        ...emptyBoard.workspaces,
        { id: "ws_department:engineering", scope: "department", department_key: "engineering", state: "read_only", used_bytes: 512, quota_bytes: 1024, quota_override_bytes: 1024, name: "Software Engineering", file_count: 2 },
      ],
      by_type: [{ artifact_type: "task-result", files: 2, bytes: 1500 }, { artifact_type: null, files: 1, bytes: 548 }],
      by_creator: [{ kind: "employee", files: 2 }, { kind: "owner", files: 1 }],
      top_creators: [{ employee_id: "emp_1", name: "Elena Rossi", files: 2 }],
      activity: emptyBoard.activity.map((item, index) => (index === 13 ? { ...item, events: 4, errors: 1 } : item)),
      recent_events: [{ id: 9, kind: "artifact_registration_failed", level: "error", actor_name: null, text: "Did not register report.csv: the recorded output file is missing or unsafe.", workspace_id: "ws_department:engineering", created_at: at }],
      projects: { apps: 1, ready_versions: 2, stored_files: 6 },
    };
    vi.stubGlobal("fetch", vi.fn(async () => json(board)));
    render(<VaultDashboard />);
    const tiles = await screen.findAllByTestId("dashboard-tile");
    expect(tiles.map((tile) => tile.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Stored2.0 KiB"), expect.stringContaining("Versions5"), expect.stringContaining("Failed registrations1")]));
    const workspace = screen.getByTestId("dashboard-workspace");
    expect(workspace).toHaveTextContent("Software Engineering");
    expect(workspace).toHaveTextContent("read-only");
    expect(workspace).toHaveTextContent("512 B of 1.0 KiB · 50%");
    expect(within(workspace).getByRole("meter")).toHaveAttribute("aria-valuenow", "512");
    expect(screen.getAllByTestId("dashboard-type").map((row) => row.textContent)).toEqual(["Task result2 files · 1.5 KiB", "Unclassified1 file · 548 B"]);
    expect(screen.getAllByTestId("activity-day")).toHaveLength(14);
    expect(screen.getByText(/Errors were recorded on/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Elena Rossi" })).toHaveAttribute("href", "/employees/emp_1");
    expect(screen.getByTestId("dashboard-projects")).toHaveTextContent("1 app · 2 finished versions · 6 stored source files");
    expect(screen.getByTestId("dashboard-event")).toHaveTextContent("Error");
    expect(screen.getByTestId("dashboard-event")).toHaveTextContent("Engineering");
  });
});

const projectDetail: StorageProjectDetail = {
  id: "app_1",
  name: "Notes",
  description: "A notes app",
  current_version: 3,
  created_at: at,
  updated_at: at,
  versions: [
    {
      id: "av_1", number: 1, base_version: null, status: "ready", request: "Build a notes app", stack: "python", tree_sha256: "c".repeat(64), finished_at: at, folder_id: "ste_v1", stored_file_count: 1, stored_bytes: 13, removed: [],
      files: [{ path: "server.py", area: "backend", purpose: "The server", author_name: "Marcus Chen", author_role: "Backend Developer", entry_id: "ste_s1", state: "available", size_bytes: 13, sha256: "d".repeat(64), change: null, previous_entry_id: null }],
    },
    {
      id: "av_2", number: 2, base_version: 1, status: "ready", request: "Add a second page", stack: "python", tree_sha256: "e".repeat(64), finished_at: at, folder_id: "ste_v2", stored_file_count: 2, stored_bytes: 27, removed: ["static/old.js"],
      files: [
        { path: "server.py", area: "backend", purpose: "The server", author_name: "Marcus Chen", author_role: "Backend Developer", entry_id: "ste_s2", state: "available", size_bytes: 13, sha256: "f".repeat(64), change: "modified", previous_entry_id: "ste_s1" },
        { path: "static/app.js", area: "frontend", purpose: "The page", author_name: "Aisha Khan", author_role: "Frontend Developer", entry_id: "ste_j2", state: "available", size_bytes: 14, sha256: "1".repeat(64), change: "added", previous_entry_id: null },
        { path: "README.md", area: "docs", purpose: "How to run it", author_name: null, author_role: null, entry_id: null, state: "not_stored", size_bytes: null, sha256: null, change: "unchanged", previous_entry_id: null },
      ],
    },
    { id: "av_3", number: 3, base_version: 2, status: "failed", request: "Add login", stack: null, tree_sha256: null, finished_at: at, folder_id: null, stored_file_count: 0, stored_bytes: 0, removed: [], files: [] },
  ],
};

describe("ProjectsPage", () => {
  it("shows an honest empty state when engineering has built nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([])));
    render(<ProjectsPage />);
    expect(await screen.findByRole("heading", { name: "No engineering projects yet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Apps" })).toHaveAttribute("href", "/apps");
  });

  it("opens the newest finished version, labels each change and compares a modified file", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/storage/projects") return json([{ id: "app_1", name: "Notes", description: "A notes app", current_version: 3, latest_status: "failed", version_count: 3, ready_version_count: 2, stored_file_count: 3, stored_bytes: 40, created_at: at, updated_at: at }]);
      if (url === "/api/storage/projects/app_1") return json(projectDetail);
      if (url.startsWith("/api/storage/diff?")) return json(diff);
      if (url === "/api/storage/entries/ste_j2/preview") return new Response("app();\n", { headers: { "content-type": "text/plain" } });
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<ProjectsPage />);

    expect(await screen.findByRole("heading", { name: "Notes" })).toBeInTheDocument();
    expect(screen.getByText(/2 of 3 versions ready · 3 files/)).toBeInTheDocument();
    // Version 3 failed, so the viewer opens version 2: the newest one that is really stored.
    expect(screen.getByRole("button", { name: /Version 2/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("project-stored-count")).toHaveTextContent("2 of 3 files stored");
    const rows = screen.getAllByTestId("project-file");
    expect(rows.map((row) => row.textContent)).toEqual([
      "server.pyModifiedMarcus Chen13 BStored",
      "static/app.jsAddedAisha Khan14 BStored",
      "README.mdUnchanged——Not stored",
    ]);
    expect(screen.getByText(/Removed since version 1/)).toHaveTextContent("static/old.js");

    fireEvent.click(within(rows[0]!).getByRole("button", { name: "server.py" }));
    expect(await screen.findByTestId("diff-summary")).toHaveTextContent("2 lines added, 1 line removed.");
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/storage/diff?before_entry=ste_s1&after_entry=ste_s2")).toBe(true);

    fireEvent.click(within(rows[1]!).getByRole("button", { name: "static/app.js" }));
    expect(await screen.findByTestId("project-file-content")).toHaveTextContent("app();");
    fireEvent.click(screen.getByRole("tab", { name: "Changes since version 1" }));
    expect(screen.getByText("This file is new in version 2.")).toBeInTheDocument();

    fireEvent.click(within(rows[2]!).getByRole("button", { name: "README.md" }));
    expect(screen.getByText(/has not been stored in the Vault/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Version 3/ }));
    expect(screen.getByText(/This version is failed. Only finished \(ready\) versions are stored/)).toBeInTheDocument();
  });
});
