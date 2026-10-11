"use client";

import { useEffect, useState } from "react";

import { fetchDiff, type DiffRequest, type StorageDiff } from "@/lib/storage";

import { bytes } from "./format";

const LINE_STYLE = {
  add: "bg-nx-ok/10 text-nx-text",
  remove: "bg-nx-error/10 text-nx-text",
  context: "text-nx-muted",
  hunk: "bg-white/[0.04] text-nx-faint",
} as const;
const MARK = { add: "+", remove: "−", context: " ", hunk: "" } as const;

/** What a finished comparison says, in words: the colours are never the only signal. */
export function diffSummary(diff: StorageDiff): string {
  if (diff.identical) return "These two versions are identical.";
  if (!diff.comparable) return diff.reason ?? "These versions cannot be compared line by line.";
  if (diff.line_endings_only) return "Only line endings or the final newline differ.";
  const lines = (count: number) => `${count} line${count === 1 ? "" : "s"}`;
  return `${lines(diff.added)} added, ${lines(diff.removed)} removed.`;
}

/**
 * A bounded line comparison of two stored versions, computed by the backend from the
 * real bytes. Mount it with a `key` built from the request so a new pair starts clean.
 */
export function DiffView({ request, beforeLabel, afterLabel }: { request: DiffRequest; beforeLabel: string; afterLabel: string }) {
  const [diff, setDiff] = useState<StorageDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { beforeEntry, beforeVersion, afterEntry, afterVersion } = request;

  useEffect(() => {
    let active = true;
    void fetchDiff({ beforeEntry, beforeVersion, afterEntry, afterVersion })
      .then((result) => active && setDiff(result))
      .catch((caught: Error) => active && setError(caught.message));
    return () => {
      active = false;
    };
  }, [beforeEntry, beforeVersion, afterEntry, afterVersion]);

  if (error) return <p role="alert" className="rounded-lg bg-nx-error/10 p-3 text-xs text-nx-error ring-1 ring-nx-error/30">{error}</p>;
  if (!diff) return <p role="status" className="p-3 text-xs text-nx-muted">Comparing the stored versions…</p>;

  return (
    <section aria-label={`Changes from ${beforeLabel} to ${afterLabel}`} className="overflow-hidden rounded-xl bg-black/20 ring-1 ring-nx-line">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-nx-line px-3 py-2 text-[11px]">
        <span className="font-medium text-nx-text">{beforeLabel} → {afterLabel}</span>
        <span className="text-nx-muted" data-testid="diff-summary">{diffSummary(diff)}</span>
        <span className="ml-auto font-mono text-nx-faint">{bytes(diff.before.size_bytes)} → {bytes(diff.after.size_bytes)}</span>
      </header>
      {diff.lines.length > 0 && (
        <div className="max-h-96 overflow-auto">
          <table className="w-full border-collapse font-mono text-[11px] leading-5">
            <tbody>
              {diff.lines.map((line, index) => (
                <tr key={index} className={LINE_STYLE[line.kind]} data-kind={line.kind}>
                  <td className="w-10 px-2 text-right text-nx-faint select-none">{line.old ?? ""}</td>
                  <td className="w-10 px-2 text-right text-nx-faint select-none">{line.new ?? ""}</td>
                  <td className="w-4 text-center select-none" aria-label={line.kind === "add" ? "added" : line.kind === "remove" ? "removed" : undefined}>{MARK[line.kind]}</td>
                  <td className="px-2 whitespace-pre-wrap break-all">{line.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {diff.truncated && <p className="border-t border-nx-line px-3 py-2 text-[11px] text-nx-warn">Only the first 2,000 lines of the comparison are shown. The totals above cover the whole file.</p>}
    </section>
  );
}
