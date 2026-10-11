"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/vault", label: "Files" },
  { href: "/vault/projects", label: "Engineering projects" },
  { href: "/vault/dashboard", label: "Dashboard" },
];

/** The three Vault screens, shown under the page title on each of them. */
export function VaultTabs() {
  const path = usePathname() ?? "";
  return (
    <nav aria-label="Vault sections" className="flex flex-wrap gap-1 border-b border-nx-line pb-2">
      {TABS.map((tab) => {
        const active = path === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${active ? "bg-nx-violet/15 text-white ring-1 ring-nx-violet/30" : "text-nx-muted hover:bg-white/5 hover:text-nx-text"}`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
