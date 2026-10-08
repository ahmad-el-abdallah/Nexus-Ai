import Link from "next/link";

import { NexusMark } from "@/components/NexusMark";
import { NextStageCard } from "@/components/NextStageCard";
import { RendererCard } from "@/components/RendererCard";
import { StageRoadmap } from "@/components/StageRoadmap";
import { SystemStatus } from "@/components/SystemStatus";
import { CURRENT_STAGE, STAGES } from "@/lib/stages";

export const metadata = { title: "System status · NEXUS AI" };

export default function SystemPage() {
  const stage = STAGES.find((s) => s.id === CURRENT_STAGE);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-8 lg:py-12">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <NexusMark className="size-9 drop-shadow-[0_0_18px_rgb(139_92_246/0.45)]" />
          <div className="leading-tight">
            <p className="text-sm font-semibold tracking-[0.22em] text-nx-text">NEXUS AI</p>
            <p className="text-xs text-nx-muted">System status console</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-white/5 px-3 py-1 font-mono text-xs text-nx-muted ring-1 ring-nx-line">
            Stage {CURRENT_STAGE} of {STAGES.length} · {stage?.title}
          </span>
          <Link href="/" className="rounded-full bg-nx-violet/20 px-3 py-1 text-xs font-medium text-nx-text ring-1 ring-nx-violet/40 hover:bg-nx-violet/30">
            Enter headquarters →
          </Link>
        </div>
      </header>

      <section className="max-w-3xl py-4 lg:py-8">
        <p className="mb-4 text-xs font-semibold tracking-[0.28em] text-nx-cyan uppercase">
          Your Corporation. Your AI Workforce.
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-nx-text sm:text-5xl">
          The ground floor of <span className="text-gradient">NEXUS AI</span> is being laid.
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-nx-muted">
          This console shows the live state of the platform beneath your future headquarters. The
          3D office, your AI employees and their departments arrive stage by stage. Everything on
          this screen comes from real checks, and nothing is simulated.
        </p>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SystemStatus />
        </div>
        <div className="flex flex-col gap-6">
          <RendererCard />
          <NextStageCard />
        </div>
      </div>

      <StageRoadmap />

      <footer className="mt-auto pt-4 text-center text-xs text-nx-faint">
        NEXUS AI · local development build · runs entirely on this machine
      </footer>
    </div>
  );
}
