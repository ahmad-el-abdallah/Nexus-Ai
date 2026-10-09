import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Profile } from "@/lib/profiles";
import { useEmployeeStore } from "@/world/state/employeeStore";

import { ProfilePage } from "./ProfilePage";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/employees/e1" }));

const profile = (over: Partial<Profile> = {}): Profile => ({
  id: "e1",
  name: "Priya Nair",
  role: "Sales Development Representative",
  department: "sales",
  department_name: "Sales",
  seniority: "mid",
  gender: "female",
  desk_id: "sales-desk-2",
  avatar_seed: 202,
  status: "idle",
  status_detail: null,
  status_changed_at: "2026-10-09T00:00:00Z",
  model_id: null,
  manager: { id: "m1", name: "Marcus Bell", role: "Sales Director" },
  reports: [],
  skills: [],
  performance: { tasks_done: 0, tasks_failed: 0, revisions_requested: 0, runs_succeeded: 0, runs_failed: 0, finished_items: 0, success_rate: null, basis: "No finished tasks or runs yet" },
  rating: { average: null, count: 0 },
  active_assignments: [],
  task_history: [],
  runs: [],
  feedback: [],
  history: [],
  generated_at: "2026-10-09T00:00:00Z",
  ...over,
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function backend(route: (url: string, init?: RequestInit) => Response | undefined) {
  const calls: [string, RequestInit | undefined][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return route(url, init) ?? json({ detail: "not found" }, 404);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useEmployeeStore.setState({ employees: [], load: "ready" });
});

describe("ProfilePage", () => {
  it("shows identity and 'Not enough data' instead of a made-up score", async () => {
    backend((url) => (url.endsWith("/profile") ? json(profile()) : undefined));
    render(<ProfilePage id="e1" />);
    expect(await screen.findByRole("heading", { name: "Priya Nair" })).toBeInTheDocument();
    expect(screen.getByText("Sales Development Representative · Sales")).toBeInTheDocument();
    expect(screen.getByText("Marcus Bell")).toBeInTheDocument();
    const perf = screen.getByRole("region", { name: "Performance" });
    expect(perf).toHaveTextContent("Not enough data yet");
    expect(perf).not.toHaveTextContent("%");
  });

  it("shows evidence-based performance when there is real activity", async () => {
    backend((url) =>
      url.endsWith("/profile")
        ? json(
            profile({
              performance: { tasks_done: 2, tasks_failed: 1, revisions_requested: 2, runs_succeeded: 1, runs_failed: 1, finished_items: 5, success_rate: 60, basis: "3 of 5 finished tasks and sandbox runs succeeded" },
              task_history: [{ id: "t1", title: "Market scan", status: "done", kind: "work", workflow_id: null, revisions: 0, created_at: "2026-10-09T00:00:00Z", finished_at: "2026-10-09T00:00:00Z", has_result: true }],
            }),
          )
        : undefined,
    );
    render(<ProfilePage id="e1" />);
    const perf = await screen.findByRole("region", { name: "Performance" });
    expect(perf).toHaveTextContent("60%");
    expect(perf).toHaveTextContent("3 of 5 finished tasks");
    expect(screen.getByRole("region", { name: "Task history" })).toHaveTextContent("Market scan");
  });

  it("adds a rating and keeps it in the history", async () => {
    let state = profile();
    const calls = backend((url, init) => {
      if (url.endsWith("/feedback") && init?.method === "POST") {
        state = profile({ rating: { average: 4, count: 1 }, feedback: [{ id: 1, rating: 4, note: "Great", created_at: "2026-10-09T00:00:00Z" }], history: [{ id: 1, kind: "rated", text: "Owner feedback: 4/5", created_at: "2026-10-09T00:00:00Z" }] });
        return json(state);
      }
      if (url.endsWith("/profile")) return json(state);
    });
    render(<ProfilePage id="e1" />);
    const rating = await screen.findByRole("region", { name: "Owner rating & feedback" });
    fireEvent.click(within(rating).getByRole("radio", { name: "4 stars" }));
    fireEvent.change(within(rating).getByRole("textbox", { name: "Feedback note" }), { target: { value: "Great" } });
    fireEvent.click(within(rating).getByRole("button", { name: "Add feedback" }));
    await waitFor(() => expect(calls.some(([url, init]) => url === "/api/employees/e1/feedback" && init?.method === "POST")).toBe(true));
    expect(JSON.parse(calls.find(([url, init]) => url.endsWith("/feedback") && init?.method === "POST")![1]!.body as string)).toEqual({ rating: 4, note: "Great" });
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Feedback history" })).getByText("Great")).toBeInTheDocument());
  });

  it("saves skills the owner adds", async () => {
    let state = profile();
    const calls = backend((url, init) => {
      if (url === "/api/employees/e1" && init?.method === "PATCH") {
        state = profile({ skills: ["Prospecting"] });
        return json({});
      }
      if (url.endsWith("/profile")) return json(state);
    });
    render(<ProfilePage id="e1" />);
    const skills = await screen.findByRole("region", { name: "Skills" });
    fireEvent.change(within(skills).getByLabelText("Add a skill"), { target: { value: "Prospecting" } });
    fireEvent.click(within(skills).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls.some(([url, init]) => url === "/api/employees/e1" && init?.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls.find(([, init]) => init?.method === "PATCH")![1]!.body as string)).toEqual({ skills: ["Prospecting"] });
  });
});
