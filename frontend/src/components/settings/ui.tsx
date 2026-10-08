"use client";

import Link from "next/link";
import type { ReactNode } from "react";

export const card = "glass-solid p-5";
export const input =
  "mt-1 h-10 w-full rounded-lg bg-nx-bg/80 px-3 text-sm text-nx-text ring-1 ring-nx-line-strong focus:ring-nx-violet/60 focus:outline-none";
export const labelCls = "block text-xs font-medium text-nx-muted";
export const primaryBtn =
  "rounded-lg bg-nx-violet/30 px-4 py-2 text-sm font-semibold text-white ring-1 ring-nx-violet/60 hover:bg-nx-violet/40 disabled:opacity-50";
export const ghostBtn = "rounded-lg px-3 py-2 text-sm text-nx-text ring-1 ring-nx-line-strong hover:bg-white/5 disabled:opacity-50";

export function Section({ id, title, aside, children, className = "" }: { id: string; title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`${card} ${className}`} aria-labelledby={id}>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={id} className="text-sm font-semibold text-nx-text">
          {title}
        </h2>
        {aside && <div className="text-xs text-nx-faint">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export function Badge({ tone, children }: { tone: "ok" | "warn" | "error" | "neutral" | "info"; children: ReactNode }) {
  const tones = {
    ok: "bg-nx-ok/10 text-nx-ok ring-nx-ok/30",
    warn: "bg-nx-warn/10 text-nx-warn ring-nx-warn/30",
    error: "bg-nx-error/10 text-nx-error ring-nx-error/30",
    info: "bg-nx-cyan/10 text-nx-cyan ring-nx-cyan/30",
    neutral: "bg-white/5 text-nx-muted ring-nx-line-strong",
  } as const;
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${tones[tone]}`}>{children}</span>;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

const SETTINGS_SECTIONS: { label: string; href?: string; note?: string }[] = [
  { label: "AI providers", href: "/settings/ai" },
  { label: "Voice", href: "/settings/voice" },
  { label: "Email accounts", href: "/settings/email" },
  { label: "Company", note: "Stage 11" },
];

export function SettingsNav({ current }: { current: string }) {
  return (
    <nav aria-label="Settings sections" className="flex flex-wrap gap-2">
      {SETTINGS_SECTIONS.map((i) =>
        i.href ? (
          <Link
            key={i.label}
            href={i.href}
            aria-current={i.href === current ? "page" : undefined}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ${i.href === current ? "bg-white/10 text-white" : "text-nx-muted ring-1 ring-nx-line-strong hover:text-nx-text"}`}
          >
            {i.label}
          </Link>
        ) : (
          <span key={i.label} className="rounded-lg px-3 py-1.5 text-xs text-nx-faint ring-1 ring-nx-line" title={`Arrives in ${i.note}`}>
            {i.label} · {i.note}
          </span>
        ),
      )}
    </nav>
  );
}
