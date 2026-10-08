import { CURRENT_STAGE, STAGES } from "@/lib/stages";

/** The approved build plan. Static by design: it describes the plan, not progress. */
export function StageRoadmap() {
  return (
    <section className="glass p-6" aria-labelledby="roadmap-title">
      <header className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="roadmap-title" className="text-base font-semibold text-nx-text">
          Build roadmap
        </h2>
        <p className="text-xs text-nx-muted">
          Each stage ships only after your approval.
        </p>
      </header>
      <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {STAGES.map((stage) => {
          const current = stage.id === CURRENT_STAGE;
          const done = stage.id < CURRENT_STAGE;
          return (
            <li
              key={stage.id}
              aria-current={current ? "step" : undefined}
              className={`relative flex items-center gap-3 rounded-xl px-3 py-2.5 ring-1 ${
                current
                  ? "bg-gradient-to-r from-nx-violet/20 to-nx-cyan/10 ring-nx-violet/50"
                  : "bg-white/[0.015] ring-nx-line"
              }`}
            >
              <span
                className={`grid size-7 shrink-0 place-items-center rounded-lg font-mono text-xs ${
                  current
                    ? "bg-gradient-to-br from-nx-violet to-nx-cyan font-semibold text-white"
                    : done
                      ? "bg-nx-ok/15 text-nx-ok"
                      : "bg-white/5 text-nx-faint"
                }`}
              >
                {String(stage.id).padStart(2, "0")}
              </span>
              <span className={`text-sm ${current ? "text-nx-text" : "text-nx-muted"}`}>
                {stage.title}
              </span>
              {current && (
                <span className="ml-auto text-[10px] font-semibold tracking-wider text-nx-cyan uppercase">
                  Current
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
