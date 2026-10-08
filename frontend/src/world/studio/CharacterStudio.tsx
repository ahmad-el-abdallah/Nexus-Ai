"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useState } from "react";

import { NexusMark } from "@/components/NexusMark";

import type { StudioSlot } from "./StudioCanvas";

const StudioCanvas = dynamic(() => import("./StudioCanvas"), { ssr: false });

const STATES: Array<Omit<StudioSlot, "seed" | "department">> = [
  { label: "Idle (at desk)", activity: "sitIdle", seated: true },
  { label: "Working", activity: "sitTyping", seated: true },
  { label: "Researching", activity: "sitThinking", seated: true },
  { label: "In a meeting", activity: "sitTalking", seated: true },
  { label: "Reviewing", activity: "sitReviewing", seated: true },
  { label: "Blocked / error", activity: "sitSlumped", seated: true },
  { label: "Task completed", activity: "celebrate", seated: false },
  { label: "Standing", activity: "standIdle", seated: false },
  { label: "Walking", activity: "walk", seated: false },
  { label: "Walking", activity: "walk", seated: false },
];
const DEPARTMENTS = ["executive", "sales", "marketing", "engineering"];

function makeSlots(offset: number): StudioSlot[] {
  return STATES.map((s, i) => ({ ...s, seed: offset + i * 7 + 1, department: DEPARTMENTS[i % DEPARTMENTS.length] }));
}

/** Design preview of the character generator and every animation state. */
export function CharacterStudio() {
  const [offset, setOffset] = useState(0);
  const slots = makeSlots(offset);
  return (
    <main className="fixed inset-0">
      <div className="absolute inset-0" data-testid="character-studio">
        <StudioCanvas slots={slots} />
      </div>
      <header className="pointer-events-none absolute inset-x-4 top-4 flex flex-wrap items-start justify-between gap-3">
        <div className="glass-solid pointer-events-auto max-w-md p-4">
          <div className="flex items-center gap-2.5">
            <NexusMark className="size-7" />
            <h1 className="text-base font-semibold text-nx-text">Character studio</h1>
          </div>
          <p className="mt-2 text-sm leading-6 text-nx-muted">
            A preview of the avatar generator and every animation the office can show. These are generated sample people
            in fixed poses — <strong className="text-nx-text">not real employees or live statuses</strong>.
          </p>
        </div>
        <div className="pointer-events-auto flex gap-2">
          <button
            type="button"
            onClick={() => setOffset((o) => o + 101)}
            className="rounded-xl bg-nx-violet/25 px-4 py-2 text-sm font-medium text-nx-text ring-1 ring-nx-violet/50 hover:bg-nx-violet/35"
          >
            Generate new people
          </button>
          <Link href="/" className="rounded-xl bg-nx-bg/70 px-4 py-2 text-sm text-nx-muted ring-1 ring-nx-line-strong hover:text-nx-text">
            ← Headquarters
          </Link>
        </div>
      </header>
    </main>
  );
}
