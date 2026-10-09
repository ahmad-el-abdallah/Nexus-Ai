import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppDetail, AppFile, AppRun } from "@/lib/apps";
import { previewUrl } from "@/lib/apps";
import type { Employee } from "@/lib/employees";
import { useEmployeeStore } from "@/world/state/employeeStore";

import { AppDetailPage } from "./AppDetailPage";
import { AppsPage } from "./AppsPage";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }), usePathname: () => "/apps" }));

const person = (id: string, name: string, role: string): Employee => ({
  id,
  name,
  role,
  department: "engineering",
  seniority: "mid",
  desk_id: null,
  supervisor_id: null,
  avatar_seed: 1,
  status: "idle",
  status_detail: null,
  status_changed_at: "2026-10-08T00:00:00Z",
});

const file = (over: Partial<AppFile>): AppFile => ({
  id: 1,
  path: "server.py",
  area: "backend",
  purpose: "The notes API.",
  action: "new",
  instructions: null,
  employee_id: "e_back",
  author_name: "Yusuf Demir",
  author_role: "Backend Developer",
  status: "planned",
  error: null,
  size: 0,
  lines: 0,
  check: null,
  check_error: null,
  review_notes: null,
  revisions: 0,
  attempts: 0,
  calls: 0,
  ...over,
});

const TREE = "a".repeat(64);

function app(over: Partial<AppDetail> = {}, current: Partial<AppDetail["current"]> = {}): AppDetail {
  const status = over.status ?? "awaiting_approval";
  const version = {
    number: 1,
    base_version: null,
    request: "A shared list of notes for my team.",
    status,
    status_reason: null,
    stack: "python",
    summary: null,
    tree_sha256: null,
    calls_used: 1,
    max_calls: 45,
    prompt_tokens: 900,
    completion_tokens: 400,
    created_at: "2026-10-08T00:00:00Z",
    approved_at: null,
    finished_at: null,
  };
  return {
    id: "app_1",
    name: "Team Notes",
    description: "A shared list of notes for my team.",
    version: 1,
    ready_version: null,
    status,
    status_reason: null,
    stack: "python",
    files: { total: 3, written: 0, failed: 0 },
    calls_used: 1,
    max_calls: 45,
    prompt_tokens: 900,
    completion_tokens: 400,
    source_conversation_id: null,
    created_at: "2026-10-08T00:00:00Z",
    finished_at: null,
    versions: [version],
    events: [{ id: 1, app_id: "app_1", version: 1, created_at: "2026-10-08T00:00:00Z", kind: "designed", actor_id: "e_arch", actor_name: "Felix Schmidt", path: null, text: "Felix Schmidt designed “Team Notes”: 3 files." }],
    run: null,
    runtime: {
      available: true,
      reason: null,
      port: 8100,
      python_packages: true,
      node: true,
      registries: ["files.pythonhosted.org", "pypi.org", "registry.npmjs.org"],
      limits: { memory: "768M", processes: 128, minutes: 60, install_minutes: 5, network: false, files: "its own folder only; your files are not visible" },
      active: null,
    },
    ...over,
    current: {
      ...version,
      plan: { name: "Team Notes", summary: "The team keeps a shared list of notes.", stack: "python", api: "GET /api/notes -> [{id, text}]", packages: ["flask"], files: [] },
      stack_name: "Python backend + plain web frontend",
      architect: { id: "e_arch", name: "Felix Schmidt", role: "Software Architect" },
      files: [
        file({}),
        file({ id: 2, path: "static/app.js", area: "frontend", purpose: "Loads and adds notes.", employee_id: "e_front", author_name: "Amara Mensah", author_role: "Frontend Developer" }),
        file({ id: 3, path: "requirements.txt", area: "setup", purpose: "The Python packages.", employee_id: "e_ops", author_name: "Kenji Watanabe", author_role: "DevOps Engineer" }),
      ],
      estimate: { typical: 5, worst: 16 },
      known_issues: [],
      dependencies: [],
      ...current,
    },
  };
}

const READY_FILES = [
  file({ status: "written", size: 900, lines: 40, check: "failed", check_error: "line 9: invalid syntax", revisions: 1, review_notes: "The port is hard-coded." }),
  file({ id: 2, path: "static/app.js", area: "frontend", status: "written", size: 300, lines: 12, check: "ok", employee_id: "e_front", author_name: "Amara Mensah", author_role: "Frontend Developer" }),
  file({ id: 3, path: "README.md", area: "docs", status: "written", size: 80, lines: 4, check: "skipped", employee_id: "e_arch", author_name: "Felix Schmidt", author_role: "Software Architect" }),
];

const ready = (over: Partial<AppDetail> = {}, current: Partial<AppDetail["current"]> = {}) =>
  app(
    { status: "ready", ready_version: 1, status_reason: "1 known problem — see the files.", ...over },
    {
      status: "ready",
      status_reason: "1 known problem — see the files.",
      tree_sha256: TREE,
      summary: "## Delivered\n\nTeam Notes is stored.",
      estimate: null,
      files: READY_FILES,
      known_issues: ["server.py: line 9: invalid syntax"],
      dependencies: [{ file: "requirements.txt", registry: "PyPI", packages: ["flask"] }],
      ...current,
    },
  );

const run = (over: Partial<AppRun> = {}): AppRun => ({
  id: "apr_1",
  app_id: "app_1",
  version: 1,
  tree_sha256: TREE,
  status: "running",
  error: null,
  log: "▸ Starting the app: python3 server.py\nTeam Notes is listening\n",
  approved_at: "2026-10-08T00:05:00Z",
  started_at: "2026-10-08T00:05:02Z",
  finished_at: null,
  ...over,
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Call = [string, RequestInit | undefined];

function serve(handler: (url: string, init?: RequestInit) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return json(handler(url, init));
    }),
  );
  return calls;
}

beforeEach(() => {
  push.mockReset();
  useEmployeeStore.setState({
    employees: [person("e_arch", "Felix Schmidt", "Software Architect"), person("e_back", "Yusuf Demir", "Backend Developer"), person("e_front", "Amara Mensah", "Frontend Developer"), person("e_ops", "Kenji Watanabe", "DevOps Engineer")],
    load: "ready",
  });
});

describe("AppDetailPage", () => {
  it("shows who writes which file by role and builds only after approval", async () => {
    const calls = serve((url) => (url.endsWith("/approve") ? app({ status: "building" }, { status: "building", approved_at: "x", estimate: null }) : app()));
    render(<AppDetailPage id="app_1" />);
    const design = await screen.findByTestId("app-design");
    expect(design).toHaveTextContent("your approval is needed");
    expect(design).toHaveTextContent("By Felix Schmidt (Software Architect). Nothing has been written yet.");
    expect(design).toHaveTextContent("Python backend + plain web frontend");
    const rows = within(design).getAllByTestId("design-file");
    expect(rows.map((r) => r.dataset.area)).toEqual(["backend", "frontend", "setup"]);
    expect(rows[0]).toHaveTextContent("server.py");
    expect(rows[0]).toHaveTextContent("Yusuf Demir · Backend Developer");
    expect(rows[1]).toHaveTextContent("Amara Mensah · Frontend Developer");
    expect(rows[2]).toHaveTextContent("Kenji Watanabe · DevOps Engineer");
    expect(design).toHaveTextContent("Expected about 5 more model requests (at most 16 with retries and fixes; hard limit 45)");
    expect(screen.queryByTestId("app-run")).toBeNull(); // nothing to run yet
    expect(calls.every(([, init]) => !init?.method)).toBe(true);

    fireEvent.click(within(design).getByRole("button", { name: "Approve and build (3 files)" }));
    await waitFor(() => expect(calls.some(([url, init]) => url === "/api/apps/app_1/approve" && init?.method === "POST")).toBe(true));
    expect(await screen.findByTestId("app-status")).toHaveTextContent("Engineers are writing");
    expect(screen.queryByTestId("app-design")).toBeNull();
  });

  it("shows the result honestly: checks, review notes, known problems, and the files to read", async () => {
    const calls = serve((url) => (url.includes("/file?") ? { ...READY_FILES[0], content: "import os\nprint('notes')\n" } : ready()));
    render(<AppDetailPage id="app_1" />);
    expect(await screen.findByTestId("app-delivery")).toHaveTextContent("checked for syntax and reviewed by reading — not run or tested");
    expect(screen.getByTestId("app-issues")).toHaveTextContent("server.py: line 9: invalid syntax");
    expect(screen.getByTestId("app-status-reason")).toHaveTextContent("1 known problem");
    const files = screen.getAllByTestId("app-file");
    expect(files[0]).toHaveTextContent("Check failed");
    expect(files[0]).toHaveTextContent("Rewritten once");
    expect(files[0]).toHaveTextContent("Reviewer: The port is hard-coded. — sent back to the author, who rewrote the file. The rewrite was not reviewed again.");
    expect(files[1]).toHaveTextContent("Syntax ok");
    expect(files[2]).toHaveTextContent("Not checked"); // never shown as a pass
    expect(screen.getByRole("link", { name: "⬇ Download .zip" })).toHaveAttribute("href", "/api/apps/app_1/versions/1/download");

    fireEvent.click(within(files[0]).getByRole("button", { name: /server\.py/ }));
    expect(await screen.findByTestId("app-file-content")).toHaveTextContent("print('notes')");
    expect(calls.some(([url]) => url === "/api/apps/app_1/versions/1/file?path=server.py")).toBe(true);
  });

  it("runs a version only after the owner approves it, showing the packages and the sandbox rules", async () => {
    let started = false;
    const calls = serve((url) => {
      if (url.endsWith("/run")) {
        started = true;
        return run({ status: "installing", started_at: null, log: "" });
      }
      return ready({ run: started ? run() : null });
    });
    render(<AppDetailPage id="app_1" />);
    const panel = await screen.findByTestId("app-run");
    expect(screen.queryByTestId("app-run-dialog")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "▶ Run app" }));
    const dialog = screen.getByTestId("app-run-dialog");
    expect(dialog).toHaveTextContent("Run Team Notes (version 1)?");
    expect(dialog).toHaveTextContent("PyPI (requirements.txt): flask");
    expect(dialog).toHaveTextContent("No internet access while the app runs");
    expect(dialog).toHaveTextContent("Installing can reach only: files.pythonhosted.org, pypi.org, registry.npmjs.org");
    expect(dialog).toHaveTextContent("768M memory, 128 processes");
    expect(calls.some(([url]) => url.endsWith("/run"))).toBe(false); // nothing ran yet

    fireEvent.click(within(dialog).getByRole("button", { name: "Approve and run" }));
    await waitFor(() => expect(calls.some(([url]) => url === "/api/apps/app_1/versions/1/run")).toBe(true));
    const post = calls.find(([url]) => url.endsWith("/run"))!;
    expect(JSON.parse(post[1]!.body as string)).toEqual({ tree_sha256: TREE }); // this exact version
    expect(await screen.findByTestId("app-run-status")).toHaveTextContent("Installing packages in the sandbox…");
    expect(within(panel).getByRole("button", { name: "■ Stop" })).toBeInTheDocument();
  });

  it("links to the running app on its own address and shows its real output", async () => {
    serve(() => ready({ run: run() }));
    render(<AppDetailPage id="app_1" />);
    const open = await screen.findByTestId("app-open");
    expect(open).toHaveAttribute("href", "http://localhost:8100/");
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByTestId("app-run-log")).toHaveTextContent("Team Notes is listening");
    expect(screen.queryByRole("button", { name: "▶ Run app" })).toBeNull();
    expect(previewUrl(8100, "192.168.1.20")).toBeNull(); // only on the computer NEXUS runs on
    expect(previewUrl(null, "localhost")).toBeNull();
  });

  it("turns a failed run into a change request for the team", async () => {
    const failed = run({ status: "failed", error: "The app stopped while starting (exit code 1). The log shows why.", log: "ModuleNotFoundError: No module named 'flask'\n", finished_at: "x" });
    const calls = serve((url) => (url.endsWith("/changes") ? app({ status: "planning", version: 2, ready_version: 1 }, { number: 2, base_version: 1, status: "planning", request: "fix", files: [], plan: null, estimate: null }) : ready({ run: failed })));
    render(<AppDetailPage id="app_1" />);
    expect(await screen.findByTestId("app-run-status")).toHaveTextContent("Did not run");
    fireEvent.click(screen.getByRole("button", { name: "Ask the team to fix this →" }));
    const box = screen.getByRole("textbox", { name: "The change you want" }) as HTMLTextAreaElement;
    expect(box.value).toContain("exit code 1");
    expect(box.value).toContain("No module named 'flask'");
    fireEvent.click(screen.getByRole("button", { name: "Ask for this change" }));
    await waitFor(() => expect(calls.some(([url]) => url === "/api/apps/app_1/changes")).toBe(true));
    expect(JSON.parse(calls.find(([url]) => url.endsWith("/changes"))![1]!.body as string).request).toContain("Please fix this.");
    expect(await screen.findByText(/Felix Schmidt is planning the change/)).toBeInTheDocument();
    expect(screen.queryByTestId("app-change")).toBeNull(); // one build at a time
  });

  it("says why apps can't be run when the sandbox is missing, and when another app is running", async () => {
    const base = ready();
    serve(() => ({ ...base, runtime: { ...base.runtime, available: false, reason: "bubblewrap (bwrap) isn't installed: sudo apt install bubblewrap" } }));
    const first = render(<AppDetailPage id="app_1" />);
    expect(await screen.findByText(/Apps can't be run on this computer: bubblewrap/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "▶ Run app" })).toBeDisabled();
    first.unmount();

    serve(() => ({ ...base, runtime: { ...base.runtime, active: { run_id: "apr_9", app_id: "app_other", app_name: "Invoices", version: 1, status: "running" } } }));
    render(<AppDetailPage id="app_1" />);
    expect(await screen.findByText(/“Invoices” is running\. One app runs at a time/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "▶ Run app" })).toBeDisabled();
  });
});

describe("AppsPage", () => {
  it("asks engineering for a design and opens the new app", async () => {
    const calls = serve((_url, init) => (init?.method === "POST" ? { ...app(), id: "app_9" } : []));
    render(<AppsPage />);
    expect(await screen.findByText("No apps yet.")).toBeInTheDocument();
    expect(screen.getByText(/nothing is written until you approve it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use the example" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask for a design" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/apps/app_9"));
    const post = calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(post[1]!.body as string).description).toMatch(/^A to-do list for my team/);
  });
});
