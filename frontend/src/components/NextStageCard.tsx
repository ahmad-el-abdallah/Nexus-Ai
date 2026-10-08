import { CURRENT_STAGE, STAGES } from "@/lib/stages";

const NEXT_STAGE_SCOPE: Record<number, string[]> = {
  5: [
    "Secure NVIDIA API key handling (server-side only)",
    "Model discovery from the real catalogue",
    "Connection test, streaming, retries and timeouts",
    "Per-department / per-employee model routing",
    "Usage tracking, quotas and concurrency limits",
  ],
  4: [
    "All 20 departments with directors and rosters",
    "Organisational hierarchy and reporting lines",
    "Department pages, task areas and configuration",
    "Create, rename and reassign AI employees",
    "Changes persisted in the database",
  ],
  2: [
    "Reception, executive office and boardroom",
    "Marketing, engineering and sales floors",
    "Workstations, lighting and glass partitions",
    "Isometric camera: zoom, pan, rotate, focus",
    "Clickable rooms and department labels",
  ],
};

/** What the next approved stage will deliver. Plan information, not progress. */
export function NextStageCard() {
  const next = STAGES.find((s) => s.id === CURRENT_STAGE + 1);
  if (!next) return null;
  const scope = NEXT_STAGE_SCOPE[next.id] ?? [];

  return (
    <section className="glass flex flex-1 flex-col gap-4 p-6" aria-labelledby="next-stage-title">
      <header>
        <p className="text-[11px] font-semibold tracking-wider text-nx-faint uppercase">
          Next · Stage {next.id}
        </p>
        <h2 id="next-stage-title" className="mt-1 text-base font-semibold text-nx-text">
          {next.title}
        </h2>
      </header>
      {scope.length > 0 && (
        <ul className="flex flex-col gap-2 text-sm text-nx-muted">
          {scope.map((item) => (
            <li key={item} className="flex gap-2.5">
              <span className="mt-2 size-1 shrink-0 rounded-full bg-nx-cyan" aria-hidden />
              {item}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-auto text-xs text-nx-faint">Starts only after you approve Stage {CURRENT_STAGE}.</p>
    </section>
  );
}
