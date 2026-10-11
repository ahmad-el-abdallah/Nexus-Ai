"use client";

import { type ChangeEvent, useRef, useState } from "react";

import { downloadUrl, restoreVersion, uploadVersion, type StorageEntryDetail } from "@/lib/storage";

import { DiffView } from "./DiffView";
import { bytes, when } from "./format";

interface Props {
  detail: StorageEntryDetail;
  busy: boolean;
  onAction: (action: () => Promise<unknown>) => void;
}

const ACTION = "rounded-md px-2 py-1 text-[11px] text-nx-text ring-1 ring-nx-line hover:bg-white/10 disabled:opacity-40";

/**
 * The immutable history of one file: every version stays downloadable, any older one
 * can be compared with the current one, and restoring appends a copy as a new version.
 */
export function VersionHistory({ detail, busy, onAction }: Props) {
  const [compare, setCompare] = useState<number | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  const current = detail.current_version_number;
  const extension = detail.name.includes(".") ? `.${detail.name.split(".").pop()}` : undefined;
  const editable = !detail.trashed_at && !detail.source_managed;

  if (detail.kind === "folder") {
    return <section><h3 className="font-medium text-nx-text">Versions</h3><p className="mt-1 text-nx-faint">Folders have no versions.</p></section>;
  }

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onAction(() => uploadVersion(detail.id, file, note));
    event.target.value = "";
  };

  return (
    <section aria-label="Version history">
      <h3 className="font-medium text-nx-text">Versions · {detail.versions.length}</h3>
      {detail.source_managed && (
        <p className="mt-2 rounded-lg bg-nx-cyan/5 px-3 py-2 text-[11px] leading-4 text-nx-muted ring-1 ring-nx-cyan/20">
          This file mirrors real employee work. A new version appears only when that work changes, so its history can be viewed, compared and downloaded but not replaced or restored here.
        </p>
      )}
      {detail.trashed_at && <p className="mt-2 text-nx-faint">Restore this item from Trash to open its versions.</p>}
      <ul className="mt-2 space-y-2">
        {detail.versions.map((version) => {
          const usable = !detail.trashed_at && version.status === "available";
          return (
            <li key={version.id} data-testid="vault-version" className="rounded-lg bg-white/[0.025] p-2 ring-1 ring-nx-line">
              <p className="flex flex-wrap items-center gap-x-2 text-nx-text">
                <span className="font-mono">v{version.number}</span>
                {version.is_current && <span className="rounded bg-nx-ok/15 px-1.5 text-[10px] text-nx-ok">current</span>}
                {version.status !== "available" && <span className="rounded bg-nx-error/15 px-1.5 text-[10px] text-nx-error">{version.status}</span>}
                <span className="text-nx-muted">{bytes(version.size_bytes)}</span>
              </p>
              <p className="mt-0.5 text-[10px] text-nx-faint">{version.created_by_name ?? version.created_by_kind} · {when(version.created_at)}</p>
              {version.change_description && <p className="mt-1 text-[11px] text-nx-muted">{version.change_description}</p>}
              {usable && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <a href={downloadUrl(detail.id, version.number)} className={ACTION}>Download v{version.number}</a>
                  {!version.is_current && (
                    <button onClick={() => setCompare((open) => (open === version.number ? null : version.number))} aria-pressed={compare === version.number} className={ACTION}>
                      {compare === version.number ? "Hide comparison" : "Compare with current"}
                    </button>
                  )}
                  {!version.is_current && editable && (
                    <button
                      disabled={busy}
                      onClick={() => (confirmRestore === version.number ? onAction(() => restoreVersion(detail.id, version.number)) : setConfirmRestore(version.number))}
                      className={`${ACTION} ${confirmRestore === version.number ? "bg-nx-warn/15 text-nx-warn ring-nx-warn/40" : ""}`}
                    >
                      {confirmRestore === version.number ? `Confirm: make v${version.number} current` : "Restore"}
                    </button>
                  )}
                </div>
              )}
              {confirmRestore === version.number && <p className="mt-1.5 text-[10px] leading-4 text-nx-faint">Restoring adds a copy as v{current + 1}. Versions 1–{current} stay as they are.</p>}
              {compare === version.number && usable && (
                <div className="mt-2">
                  <DiffView
                    key={`${detail.id}:${version.number}:${current}`}
                    request={{ beforeEntry: detail.id, beforeVersion: version.number, afterEntry: detail.id, afterVersion: current }}
                    beforeLabel={`v${version.number}`}
                    afterLabel={`v${current} (current)`}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {editable && (
        <div className="mt-3 rounded-lg bg-white/[0.025] p-2 ring-1 ring-nx-line">
          <label className="block text-[11px] text-nx-muted">
            What changed (optional)
            <input aria-label="Version note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="Second draft" className="mt-1 w-full rounded-md bg-black/20 px-2 py-1.5 text-xs text-nx-text ring-1 ring-nx-line outline-none focus:ring-nx-violet" />
          </label>
          <button disabled={busy} onClick={() => uploadRef.current?.click()} className="mt-2 w-full rounded-md bg-nx-cyan/10 px-3 py-1.5 text-xs font-medium text-nx-cyan ring-1 ring-nx-cyan/30 disabled:opacity-40">
            Upload new version
          </button>
          <input ref={uploadRef} type="file" accept={extension} aria-label="New version file" className="hidden" onChange={upload} />
          <p className="mt-1.5 text-[10px] leading-4 text-nx-faint">The file becomes v{current + 1} of {detail.name}. Earlier versions are kept.</p>
        </div>
      )}
    </section>
  );
}
