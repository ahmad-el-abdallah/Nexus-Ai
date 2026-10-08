import { describe, expect, it } from "vitest";

import type { Employee } from "@/lib/employees";
import type { Screen } from "@/lib/screens";

import { markdownLines } from "./draw";
import { appFor, monitorView, slug, viewKey } from "./model";

const person = (over: Partial<Employee> = {}): Employee => ({
  id: "e1",
  name: "Amara Mensah",
  role: "Frontend Developer",
  department: "engineering",
  seniority: "mid",
  desk_id: "engineering-desk-3",
  supervisor_id: null,
  avatar_seed: 1,
  status: "working",
  status_detail: "Working on: API design",
  status_changed_at: "2026-10-08T00:00:00Z",
  ...over,
});

const screen = (over: Partial<Screen> = {}): Screen => ({
  kind: "work",
  title: "API design for meeting notes",
  brief: "Design the API for saving notes.",
  text: "## Endpoints\n- POST /notes",
  thinking: false,
  done: false,
  failed: false,
  started_at: "2026-10-08T00:00:00Z",
  ...over,
});

describe("desk monitors", () => {
  it("styles the screen by role", () => {
    expect(appFor("engineering")).toBe("code");
    expect(appFor("security")).toBe("terminal");
    expect(appFor("finance")).toBe("sheet");
    expect(appFor("sales")).toBe("crm");
    expect(appFor("marketing")).toBe("docs");
    expect(appFor("design")).toBe("design");
    expect(appFor("unknown-dept")).toBe("docs");
  });

  it("shows exactly the real work in progress, newest text first", () => {
    const v = monitorView(person(), screen(), 0, 1);
    expect(v).toMatchObject({ mode: "work", app: "code", file: "api-design-for-meeting-notes.md", heading: "API design for meeting notes", body: "## Endpoints\n- POST /notes", tail: true, tone: "live", status: "● Writing live" });
    expect(v.context).toBe("Design the API for saving notes.");
  });

  it("puts the brief (or the work under review) on the second monitor", () => {
    expect(monitorView(person(), screen(), 1, 2)).toMatchObject({ role: "brief", heading: "Brief", body: "Design the API for saving notes." });
    const review = screen({ kind: "review", title: "Reviewing Diego Alvarez: Sales plan", brief: "The draft", text: '{"decision": "approve"' });
    expect(monitorView(person(), review, 1, 2)).toMatchObject({ heading: "Under review", body: "The draft" });
    expect(monitorView(person(), review, 0, 2).context).toBe("");
  });

  it("is honest about thinking, finished and failed states", () => {
    expect(monitorView(person(), screen({ text: "", thinking: true }), 0, 1)).toMatchObject({ tone: "thinking", status: "Thinking… (reasoning isn't shown)" });
    expect(monitorView(person(), screen({ text: "" }), 0, 1).status).toBe("Waiting for the first words…");
    expect(monitorView(person(), screen({ done: true }), 0, 1)).toMatchObject({ tone: "done", status: "✓ Delivered" });
    expect(monitorView(person(), screen({ kind: "chat", done: true }), 0, 1)).toMatchObject({ status: "✓ Reply sent", file: "reply.md" });
    expect(monitorView(person(), screen({ failed: true }), 0, 1).tone).toBe("failed");
  });

  it("shows no invented work when idle, and nothing when suspended", () => {
    expect(monitorView(person({ status: "idle", status_detail: null }), null, 0, 2)).toMatchObject({ mode: "idle", body: "No active task", status: "Idle" });
    expect(monitorView(person({ status: "assigned", status_detail: "2 workflow tasks waiting" }), null, 0, 1).status).toBe("2 workflow tasks waiting");
    expect(monitorView(person({ status: "suspended" }), screen(), 0, 1).mode).toBe("off");
  });

  it("redraws only when what is shown changes", () => {
    const a = viewKey(monitorView(person(), screen(), 0, 1));
    expect(viewKey(monitorView(person(), screen(), 0, 1))).toBe(a);
    expect(viewKey(monitorView(person(), screen({ text: "## Endpoints\n- POST /notes\n- GET /notes" }), 0, 1))).not.toBe(a);
  });

  it("renders light Markdown for the screen", () => {
    expect(markdownLines("# Plan\n- **one**\n```py\nx = 1\n```\ntext")).toEqual([
      { text: "Plan", style: "heading" },
      { text: "• one", style: "bullet" },
      { text: "x = 1", style: "code" },
      { text: "text", style: "text" },
    ]);
    expect(slug("Ünïcode & Spaces — Plan!")).toBe("unicode-spaces-plan");
    expect(slug("")).toBe("untitled");
  });
});
