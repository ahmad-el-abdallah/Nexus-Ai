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
 * How each real status is shown in the office. "working" is set while an
 * employee writes a chat reply (Stage 6); the other working states are set only
 * by the task system (Stage 8+). Nothing here invents them.
 */
export const STATUS_META: Record<EmployeeStatus, StatusMeta> = {
  idle: { label: "Idle", color: "#94a3b8", description: "Available — no work assigned.", location: "desk", activity: "sitIdle" },
  assigned: { label: "Assigned", color: "#38bdf8", description: "Has received a task that hasn't started yet.", location: "desk", activity: "sitIdle" },
  working: { label: "Working", color: "#34d399", description: "Working — replying in chat or executing a task.", location: "desk", activity: "sitTyping" },
  researching: { label: "Researching", color: "#22d3ee", description: "Gathering information for a task.", location: "desk", activity: "sitThinking" },
  meeting: { label: "In a meeting", color: "#818cf8", description: "Taking part in a meeting.", location: "meeting", activity: "sitTalking" },
  reviewing: { label: "Reviewing", color: "#a78bfa", description: "Reviewing another employee's work.", location: "desk", activity: "sitReviewing" },
  blocked: { label: "Blocked", color: "#fbbf24", description: "Waiting on input, a tool or an approval.", location: "desk", activity: "sitSlumped" },
  completed: { label: "Completed", color: "#4ade80", description: "Just finished a task.", location: "desk", activity: "celebrate" },
  error: { label: "Error", color: "#fb7185", description: "The last task failed and needs attention.", location: "desk", activity: "sitSlumped" },
  suspended: { label: "Suspended", color: "#64748b", description: "Taken out of service by the owner.", location: "away", activity: "standIdle" },
};
