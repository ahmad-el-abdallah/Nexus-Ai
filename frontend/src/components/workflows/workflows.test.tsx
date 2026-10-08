import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/chat";
import type { Department } from "@/lib/departments";
import type { Employee } from "@/lib/employees";
import type { WorkflowDetail } from "@/lib/workflows";
import { useDepartmentStore } from "@/world/state/departmentStore";
import { useEmployeeStore } from "@/world/state/employeeStore";

import { WorkflowDetailPage } from "./WorkflowDetailPage";
import { WorkflowsPage } from "./WorkflowsPage";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }), usePathname: () => "/workflows" }));

const person = (id: string, name: string, department: string): Employee => ({
  id,
  name,
  role: "Lead",
  department,
  seniority: "director",
  desk_id: null,
  supervisor_id: null,
  avatar_seed: 1,
  status: "idle",
  status_detail: null,
  status_changed_at: "2026-10-08T00:00:00Z",
});

const task = (over: Partial<Task>): Task => ({
  id: "t",
  title: "Task",
  description: "Do it.",
  department: "research",
  assignee_id: null,
  status: "proposed",
  source_conversation_id: null,
  source_message_id: null,
  created_at: "2026-10-08T00:00:00Z",
  updated_at: "2026-10-08T00:00:00Z",
  kind: "assignment",
  workflow_id: "wf_1",
  parent_id: null,
  depends_on: [],
  position: 0,
  attempts: 0,
  revisions: 0,
  result: null,
  review_notes: null,
  error: null,
  calls: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  started_at: null,
  finished_at: null,
  ...over,
});

const workflow = (over: Partial<WorkflowDetail> = {}): WorkflowDetail => ({
  id: "wf_1",
  title: "New software opportunity",
  objective: "Research a new software business opportunity and create an implementation plan.",
  status: "awaiting_approval",
  status_reason: null,
  ceo_id: "ceo",
  departments: ["research", "engineering"],
  assignments: { total: 2, done: 0, failed: 0 },
  work: {},
  calls_used: 1,
  max_calls: 45,
  prompt_tokens: 900,
  completion_tokens: 400,
  steps_in_flight: 0,
  source_conversation_id: null,
  source_task_id: null,
  created_at: "2026-10-08T00:00:00Z",
  approved_at: null,
  finished_at: null,
  plan: { summary: "Research first, then plan the build.", deliverable: "A report", assignments: [] },
  result: null,
  estimate: { typical: 8, worst: 30 },
  tasks: [
    task({ id: "a1", title: "Market scan", department: "research", assignee_id: "r1" }),
    task({ id: "a2", title: "Implementation plan", department: "engineering", assignee_id: "e1", depends_on: ["a1"], position: 1 }),
  ],
  events: [],
  ...over,
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  push.mockReset();
  useEmployeeStore.setState({ employees: [person("ceo", "Aria Vance", "executive"), person("r1", "Chloé Dubois", "research"), person("e1", "Iris Wong", "engineering"), person("e2", "Amara Mensah", "engineering")], load: "ready" });
  useDepartmentStore.setState({
    departments: [
      { key: "executive", name: "Executive Management", director_id: "ceo", color: "#a78bfa" },
      { key: "research", name: "Market Research & Innovation", director_id: "r1", color: "#a3e635" },
      { key: "engineering", name: "Software Engineering", director_id: "e1", color: "#22d3ee" },
    ] as unknown as Department[],
    load: "ready",
  });
});

describe("WorkflowDetailPage", () => {
  it("asks for approval, shows dependencies and the cost estimate, and approves without removed departments", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push([url, init]);
        if (url.endsWith("/approve")) return json(workflow({ status: "running", approved_at: "2026-10-08T00:01:00Z" }));
        return json(workflow());
      }),
    );
    render(<WorkflowDetailPage id="wf_1" />);
    const plan = await screen.findByTestId("plan-review");
    expect(plan).toHaveTextContent("Research first, then plan the build.");
    expect(plan).toHaveTextContent("Starts after: Market scan");
    expect(plan).toHaveTextContent("Expected about 8 more model requests (at most 30");
    expect(within(plan).getAllByTestId("plan-assignment")[1]).toHaveTextContent("supervised by Iris Wong");
    fireEvent.click(within(plan).getByRole("checkbox", { name: "Include Market Research & Innovation" }));
    fireEvent.click(within(plan).getByRole("button", { name: "Approve and run (1 department)" }));
    await waitFor(() => expect(calls.some(([url]) => url === "/api/workflows/wf_1/approve")).toBe(true));
    const approve = calls.find(([url]) => url.endsWith("/approve"))!;
    expect(JSON.parse(approve[1]!.body as string)).toEqual({ exclude: ["a1"] });
    expect(await screen.findByTestId("workflow-status")).toHaveTextContent("Running");
  });

  it("shows departments, worker tasks, reviews, hand-offs and the final report", async () => {
    const done = workflow({
      status: "completed",
      approved_at: "2026-10-08T00:01:00Z",
      assignments: { total: 2, done: 2, failed: 0 },
      result: "## Summary\n\nPilot a focused product.",
      tasks: [
        task({ id: "a1", title: "Market scan", department: "research", assignee_id: "r1", status: "done", result: "Findings" }),
        task({ id: "a2", title: "Implementation plan", department: "engineering", assignee_id: "e1", depends_on: ["a1"], status: "done", position: 1, result: "Plan" }),
        task({ id: "w1", kind: "work", parent_id: "a2", title: "API design", department: "engineering", assignee_id: "e2", status: "done", revisions: 1, review_notes: "Looks good.", calls: 4, result: "Design" }),
      ],
      events: [
        { id: 1, workflow_id: "wf_1", task_id: "a2", created_at: "2026-10-08T00:02:00Z", kind: "handoff", actor_id: null, actor_name: null, from_department: "research", to_department: "engineering", text: "Market Research & Innovation handed “Market scan” to Software Engineering." },
      ],
    });
    vi.stubGlobal("fetch", vi.fn(async () => json(done)));
    render(<WorkflowDetailPage id="wf_1" />);
    expect(await screen.findByTestId("final-report")).toHaveTextContent("Pilot a focused product.");
    const eng = screen.getAllByTestId("assignment").find((el) => el.dataset.department === "engineering")!;
    expect(eng).toHaveTextContent("Needs: Market Research & Innovation ✓");
    const work = within(eng).getByTestId("work-task");
    expect(work).toHaveTextContent("Amara Mensah · revised 1× · 4 requests");
    expect(work).toHaveTextContent("Supervisor: Looks good.");
    expect(screen.getByTestId("timeline")).toHaveTextContent("Market Research & Innovation → Software Engineering");
    expect(screen.queryByRole("button", { name: "Cancel workflow" })).toBeNull();
  });

  it("explains a pause and offers Resume", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(workflow({ status: "paused", approved_at: "x", status_reason: "Paused: The company's daily AI request budget (500) is used up. Press Resume when this is resolved." }))));
    render(<WorkflowDetailPage id="wf_1" />);
    expect(await screen.findByTestId("status-reason")).toHaveTextContent("daily AI request budget");
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel workflow" })).toBeInTheDocument();
  });
});

describe("WorkflowsPage", () => {
  it("sends an objective to the CEO and opens the new workflow", async () => {
    const employees = useEmployeeStore.getState().employees;
    const departments = useDepartmentStore.getState().departments;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json({ ...workflow(), id: "wf_9" }, 201)
        : url === "/api/employees"
          ? json(employees)
          : url === "/api/departments"
            ? json(departments)
            : json([]),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkflowsPage />);
    expect(await screen.findByText("No workflows yet.")).toBeInTheDocument();
    expect(screen.getByText(/Aria Vance drafts a plan; nothing runs until you approve it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use the example" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask the CEO to plan it" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/workflows/wf_9"));
    const post = (fetchMock.mock.calls as unknown as [string, RequestInit][]).find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(post[1].body as string).objective).toMatch(/^Research a new software business opportunity/);
  });
});
