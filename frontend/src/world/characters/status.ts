import type { EmployeeStatus } from "@/lib/employees";

export type Activity =
  | "sitIdle"
  | "sitTyping"
  | "sitThinking"
  | "sitTalking"
  | "sitReviewing"
  | "sitSlumped"
  | "standIdle"
  | "celebrate";

export type Location = "desk" | "meeting" | "away";

export interface StatusMeta {
  label: string;
  color: string;
  /** Plain-language meaning shown to the owner. */
  description: string;
  location: Location;
  activity: Activity;
}

/**
 * How each real status is shown in the office. Statuses come from what the
 * employee is actually doing: a chat reply or a workflow step (working,
 * reviewing), waiting workflow tasks (assigned), or a just-finished / failed
 * task (completed / error, for a few seconds). Nothing here invents them.
 */
export const STATUS_META: Record<EmployeeStatus, StatusMeta> = {
  idle: { label: "Idle", color: "#94a3b8", description: "Available — no work assigned.", location: "desk", activity: "sitIdle" },
  assigned: { label: "Assigned", color: "#38bdf8", description: "Has workflow tasks waiting to start.", location: "desk", activity: "sitIdle" },
  working: { label: "Working", color: "#34d399", description: "Working — replying in chat or on a workflow task.", location: "desk", activity: "sitTyping" },
  researching: { label: "Researching", color: "#22d3ee", description: "Gathering information for a task.", location: "desk", activity: "sitThinking" },
  meeting: { label: "In a meeting", color: "#818cf8", description: "Taking part in a meeting.", location: "meeting", activity: "sitTalking" },
  reviewing: { label: "Reviewing", color: "#a78bfa", description: "Reviewing a team member's work in a workflow.", location: "desk", activity: "sitReviewing" },
  blocked: { label: "Blocked", color: "#fbbf24", description: "Waiting on input, a tool or an approval.", location: "desk", activity: "sitSlumped" },
  completed: { label: "Completed", color: "#4ade80", description: "Just finished a workflow task.", location: "desk", activity: "celebrate" },
  error: { label: "Error", color: "#fb7185", description: "The last workflow task failed — see the workflow.", location: "desk", activity: "sitSlumped" },
  suspended: { label: "Suspended", color: "#64748b", description: "Taken out of service by the owner.", location: "away", activity: "standIdle" },
};
