export type Tone = "ok" | "warn" | "error" | "planned" | "neutral";

const TONES: Record<Tone, { dot: string; text: string; ring: string }> = {
  ok: { dot: "bg-nx-ok", text: "text-nx-ok", ring: "ring-nx-ok/25 bg-nx-ok/10" },
  warn: { dot: "bg-nx-warn", text: "text-nx-warn", ring: "ring-nx-warn/25 bg-nx-warn/10" },
  error: { dot: "bg-nx-error", text: "text-nx-error", ring: "ring-nx-error/25 bg-nx-error/10" },
  planned: { dot: "bg-nx-indigo", text: "text-nx-indigo", ring: "ring-nx-indigo/25 bg-nx-indigo/10" },
  neutral: { dot: "bg-nx-faint", text: "text-nx-muted", ring: "ring-nx-line-strong bg-white/5" },
};

export function StatusDot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return (
    <span
      className={`inline-block size-2 shrink-0 rounded-full ${TONES[tone].dot} ${pulse ? "nx-pulse" : ""}`}
      aria-hidden
    />
  );
}

export function StatusPill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const t = TONES[tone];
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${t.ring} ${t.text}`}
    >
      <StatusDot tone={tone} pulse={tone === "ok"} />
      {children}
    </span>
  );
}
