"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect } from "react";

import { NexusMark } from "@/components/NexusMark";
import { startRosterSync } from "@/world/state/employeeStore";

export const NAV = [
  { href: "/", label: "Headquarters" },
  { href: "/chat", label: "Chat" },
  { href: "/workflows", label: "Workflows" },
  { href: "/departments", label: "Departments" },
  { href: "/org", label: "Org chart" },
  { href: "/settings/ai", label: "Settings" },
  { href: "/system", label: "System" },
];

export function NavLinks({ compact = false }: { compact?: boolean }) {
  const path = usePathname() ?? "";
  return (
    <nav aria-label="Main" className="-mx-1 flex max-w-full items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none]">
      {NAV.map((item) => {
        const active = item.href === "/" ? path === "/" : path.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium whitespace-nowrap transition ${
              active ? "bg-white/10 text-white" : "text-nx-muted hover:bg-white/5 hover:text-nx-text"
            } ${compact && (item.href === "/system" || item.href === "/settings/ai" || item.href === "/org") ? "hidden 2xl:inline" : ""}`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Page frame for the management screens (everything except the 3D headquarters). */
export function AppShell({ title, subtitle, actions, children }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  useEffect(() => startRosterSync(), []);
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="flex items-center gap-2.5">
          <NexusMark className="size-8" />
          <span className="text-sm font-semibold tracking-[0.22em] text-nx-text">NEXUS AI</span>
        </Link>
        <NavLinks />
      </header>
      <div className="flex flex-wrap items-end justify-between gap-4 pt-2">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-nx-text">{title}</h1>
          {subtitle && <div className="mt-2 max-w-3xl text-sm leading-6 text-nx-muted">{subtitle}</div>}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

export function LoadState({ load, error, empty }: { load: string; error: string | null; empty?: boolean }) {
  if (load === "error") {
    return (
      <p role="alert" className="glass-solid p-5 text-sm text-nx-error">
        Couldn&apos;t reach the backend ({error}). Start it with <code className="font-mono">make dev</code>.
      </p>
    );
  }
  if (load !== "ready" || empty) return <p className="text-sm text-nx-muted">Loading…</p>;
  return null;
}
