/**
 * What each desk monitor shows. Pure (no canvas) so it can be tested.
 *
 * The *style* of the screen follows the employee's role (engineers get a code
 * editor, finance a spreadsheet, …); the *content* is always real: the task or
 * message they are actually handling and the text they are producing, live.
 * Nothing is invented — an engineer's editor shows code only when they write code.
 */

import type { Employee } from "@/lib/employees";
import type { Screen } from "@/lib/screens";

export type App = "code" | "terminal" | "notebook" | "design" | "docs" | "crm" | "sheet" | "legal" | "brief";

export const APP_BY_DEPARTMENT: Record<string, App> = {
  engineering: "code",
  it: "code",
  "quality-assurance": "code",
  security: "terminal",
  data: "notebook",
  design: "design",
  marketing: "docs",
  "public-relations": "docs",
  product: "docs",
  research: "docs",
  "human-resources": "docs",
  knowledge: "docs",
  sales: "crm",
  "customer-support": "crm",
  finance: "sheet",
  procurement: "sheet",
  legal: "legal",
  executive: "brief",
  "project-management": "brief",
  operations: "brief",
};

export const APP_NAME: Record<App, string> = {
  code: "Code editor",
  terminal: "Terminal",
  notebook: "Notebook",
  design: "Design canvas",
  docs: "Documents",
  crm: "CRM",
  sheet: "Spreadsheet",
  legal: "Documents",
  brief: "Briefing",
};

export interface MonitorView {
  mode: "off" | "idle" | "work";
  app: App;
  appName: string;
  file: string;
  heading: string;
  /** Text to show; for live output the end is shown (it grows as they type). */
  body: string;
  /** A short excerpt of the brief, on single-monitor desks. */
  context: string;
  role: "output" | "brief";
  tail: boolean;
  status: string;
  tone: "live" | "thinking" | "done" | "failed" | "idle";
  person: string;
  personRole: string;
}

export function appFor(department: string): App {
  return APP_BY_DEPARTMENT[department] ?? "docs";
}

export function slug(title: string): string {
  const s = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/g, "");
  return s || "untitled";
}

const BRIEF_HEADING: Record<string, string> = {
  chat: "Owner's message",
  review: "Under review",
  summary: "Team results",
};

function liveStatus(screen: Screen): Pick<MonitorView, "status" | "tone"> {
  if (screen.failed) return { status: "✕ Not finished", tone: "failed" };
  if (screen.done) return { status: screen.kind === "chat" ? "✓ Reply sent" : screen.kind === "review" ? "✓ Review done" : "✓ Delivered", tone: "done" };
  if (screen.thinking && !screen.text) return { status: "Thinking… (reasoning isn't shown)", tone: "thinking" };
  if (!screen.text) return { status: "Waiting for the first words…", tone: "thinking" };
  return { status: "● Writing live", tone: "live" };
}

/** The view for monitor `index` (0 = left/main) of a desk with `monitors` screens. */
export function monitorView(employee: Employee, screen: Screen | null | undefined, index: number, monitors: 1 | 2): MonitorView {
  const app = appFor(employee.department);
  const base = { app, appName: APP_NAME[app], person: employee.name, personRole: employee.role };
  if (employee.status === "suspended") {
    return { ...base, mode: "off", file: "", heading: "", body: "", context: "", role: "output", tail: false, status: "", tone: "idle" };
  }
  if (!screen) {
    return {
      ...base,
      mode: "idle",
      file: "",
      heading: employee.name,
      body: index === 0 ? "No active task" : "",
      context: "",
      role: "output",
      tail: false,
      status: employee.status === "assigned" ? (employee.status_detail ?? "Tasks waiting") : "Idle",
      tone: "idle",
    };
  }
  const file = screen.kind === "chat" ? "reply.md" : `${slug(screen.title)}.md`;
  if (monitors === 2 && index === 1) {
    return {
      ...base,
      mode: "work",
      file: screen.kind === "review" ? `${slug(screen.title)}.md` : "brief.md",
      heading: BRIEF_HEADING[screen.kind] ?? "Brief",
      body: screen.brief,
      context: "",
      role: "brief",
      tail: false,
      status: screen.title,
      tone: "idle",
    };
  }
  return {
    ...base,
    mode: "work",
    file,
    heading: screen.title,
    body: screen.text,
    context: monitors === 1 ? screen.brief : "",
    role: "output",
    tail: true,
    ...liveStatus(screen),
  };
}

/** A cheap fingerprint so a monitor redraws only when what it shows changes. */
export function viewKey(v: MonitorView): string {
  return [v.mode, v.app, v.file, v.heading, v.status, v.tone, v.person, v.body.length, v.body.slice(-64), v.context.length].join("|");
}
