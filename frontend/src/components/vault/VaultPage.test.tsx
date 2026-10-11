import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VaultPage } from "./VaultPage";

vi.mock("next/navigation", () => ({ usePathname: () => "/vault" }));
vi.mock("@/world/state/employeeStore", () => ({ startRosterSync: vi.fn() }));

const timestamp = "2026-10-09T08:30:00Z";
const folder = {
  id: "ste_folder",
  workspace_id: "ws_company",
  parent_id: null,
  kind: "folder",
  name: "Release",
  path: "Release",
  description: null,
  status: "available",
  current_version_number: 0,
  size_bytes: null,
  mime_type: null,
  sha256: null,
  tags: [],
  favorite: false,
  preview_kind: "none",
  trashed_at: null,
  created_at: timestamp,
  updated_at: timestamp,
};
const file = {
  ...folder,
  id: "ste_file",
  kind: "file",
  name: "release-notes.md",
  path: "release-notes.md",
  description: "Launch checklist",
  current_version_number: 1,
  size_bytes: 18,
  mime_type: "text/markdown",
  sha256: "a".repeat(64),
  tags: ["release"],
  preview_kind: "text",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("VaultPage", () => {
  beforeEach(() => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/storage/workspaces") {
        return json([{ id: "ws_company", scope: "company", department_key: null, state: "active", used_bytes: 18, quota_bytes: 1024, quota_override_bytes: null }]);
      }
      if (url === "/api/storage/entries/ste_file") {
        return json({
          ...file,
          original_name: "release-notes.md",
          artifact_type: null,
          visibility: "company",
          created_by_kind: "owner",
          created_by_employee_id: null,
          created_by_name: "Owner",
          owner_kind: "company",
          owner_id: "company",
          owner_name: "Nexus AI",
          source_managed: false,
          versions: [{ id: "stv_1", number: 1, mime_type: "text/markdown", size_bytes: 18, sha256: "a".repeat(64), status: "available", is_current: true, change_description: null, created_by_kind: "owner", created_by_name: "Owner", created_at: timestamp }],
          links: [],
          events: [{ id: 1, kind: "file_uploaded", level: "info", actor_name: "Owner", text: "Uploaded release notes.", created_at: timestamp }],
        });
      }
      if (url === "/api/storage/entries/ste_file/preview") {
        return new Response("# Release\nShip safely.", { headers: { "content-type": "text/plain" } });
      }
      if (url === "/api/storage/workspaces/ws_company/folders" && init?.method === "POST") return json(folder, 201);
      if (url.startsWith("/api/storage/search?")) {
        const params = new URLSearchParams(url.split("?")[1]);
        const items = params.get("kind") === "folder" ? [folder] : [folder, file];
        return json({ items, total: items.length, offset: 0, limit: 50 });
      }
      if (url === "/api/storage/grants?entry_id=ste_file") {
        return json([{ id: "stg_1", workspace_id: "ws_company", entry_id: "ste_file", grantee_kind: "department", grantee_id: "marketing", permission: "write", expires_at: null, revoked_at: null, created_at: timestamp, grantee_name: "Marketing", entry_name: "release-notes.md", entry_path: "release-notes.md", entry_kind: "file", inherited: false }]);
      }
      if (url === "/api/departments" || url === "/api/employees") return json([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("browses real entries, renders a safe preview, searches, switches view and creates a folder", async () => {
    render(<VaultPage />);

    expect(await screen.findByText("release-notes.md")).toBeInTheDocument();
    fireEvent.click(screen.getByText("release-notes.md"));
    expect(await screen.findByRole("heading", { name: "release-notes.md" })).toBeInTheDocument();
    expect(await screen.findByText((_, element) => element?.tagName === "PRE" && element.textContent?.includes("Ship safely.") === true)).toBeInTheDocument();
    expect(screen.getByText("Nexus AI")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/storage/entries/ste_file/download");
    expect(screen.getByRole("link", { name: "Download v1" })).toHaveAttribute("href", "/api/storage/entries/ste_file/download?version=1");
    expect(screen.getByRole("navigation", { name: "Vault sections" })).toBeInTheDocument();
    const sharing = await screen.findByTestId("item-grant");
    expect(sharing).toHaveTextContent("Marketing · can read and change");
    expect(sharing).toHaveTextContent("shared directly · no expiry");

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByRole("columnheader", { name: "Updated" })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Search names/), { target: { value: "release" } });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("q=release"))).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: /AI generated/ }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("tag=ai-generated"))).toBe(true));
    expect(screen.getByRole("button", { name: "Upload file" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Shared/ }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("shared=true"))).toBe(true));
    expect(screen.getByRole("button", { name: "Upload file" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /All files/ }));

    fireEvent.click(screen.getByRole("button", { name: "+ New folder" }));
    const folderName = screen.getByLabelText("New folder name");
    fireEvent.change(folderName, { target: { value: "Planning" } });
    fireEvent.click(within(folderName.closest("form")!).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).endsWith("/folders") && init?.method === "POST")).toBe(true));
  });
});
