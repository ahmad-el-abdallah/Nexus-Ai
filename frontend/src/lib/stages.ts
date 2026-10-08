/** The approved 16-stage build plan. This is the plan, not a progress metric. */

export const CURRENT_STAGE = 5;

export const STAGES: ReadonlyArray<{ id: number; title: string }> = [
  { id: 1, title: "Foundation & architecture" },
  { id: 2, title: "3D office world" },
  { id: 3, title: "AI employee characters" },
  { id: 4, title: "Departments & org structure" },
  { id: 5, title: "NVIDIA AI connection" },
  { id: 6, title: "Text communication" },
  { id: 7, title: "Voice communication" },
  { id: 8, title: "Multi-agent orchestration" },
  { id: 9, title: "Company email" },
  { id: 10, title: "Profiles & ratings" },
  { id: 11, title: "Executive dashboard & projects" },
  { id: 12, title: "Meetings & collaboration" },
  { id: 13, title: "Memory & knowledge" },
  { id: 14, title: "Advanced office simulation" },
  { id: 15, title: "Security & reliability" },
  { id: 16, title: "Polish & release" },
];
