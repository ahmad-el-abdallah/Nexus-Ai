"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { type AppDetail, appDownloadUrl, type AppRun, previewUrl, RUN_ACTIVE, runApp, stopAppRun } from "@/lib/apps";

import { danger, ghost, primary, RunStatusChip } from "./ui";

const noSubscription = () => () => {};

/** The host the owner opened NEXUS on ("" while rendering on the server). */
function useHostname() {
  return useSyncExternalStore(
    noSubscription,
    () => window.location.hostname,
    () => "",
  );
}

function ApproveRun({ app, onApproved, onClose }: { app: AppDetail; onApproved: (run: AppRun) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const version = app.current;
  const { limits, registries } = app.runtime;
  const packages = version.dependencies.filter((d) => d.packages.length > 0);

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    }
  }, []);

  const approve = async () => {
    if (!version.tree_sha256) return;
    setBusy(true);
    setError(null);
    try {
      onApproved(await runApp(app.id, version.number, version.tree_sha256));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      onCancel={onClose}
      aria-labelledby="app-run-title"
      className="m-auto w-[min(44rem,calc(100vw-2rem))] rounded-2xl bg-nx-bg-raised p-0 text-nx-text ring-1 ring-nx-line-strong backdrop:bg-black/60"
      data-testid="app-run-dialog"
    >
      <div className="max-h-[85vh] space-y-4 overflow-y-auto p-6">
        <div>
          <h2 id="app-run-title" className="text-base font-semibold">
            Run {app.name} (version {version.number})?
          </h2>
          <p className="mt-1 text-xs text-nx-faint">
            {version.files.length} files written by the engineering team. They were checked for syntax and reviewed by reading; they have not been run before. This starts exactly this version.
          </p>
        </div>
        <section aria-label="Packages to install" className="rounded-lg bg-white/[0.03] p-3 text-xs ring-1 ring-nx-line">
          {packages.length === 0 ? (
            <p className="text-nx-muted">No packages to install — the app uses only what is already on this computer.</p>
          ) : (
            <>
              <p className="text-nx-muted">These packages are downloaded and installed inside the sandbox first:</p>
              <ul className="mt-2 space-y-1">
                {packages.map((d) => (
                  <li key={d.file}>
                    <span className="text-nx-faint">
                      {d.registry} ({d.file}):
                    </span>{" "}
                    <span className="font-mono text-nx-text">{d.packages.join(", ")}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
        <ul className="grid list-disc grid-cols-1 gap-x-8 gap-y-1 rounded-lg bg-white/[0.03] py-3 pr-3 pl-7 text-xs text-nx-muted ring-1 ring-nx-line sm:grid-cols-2" aria-label="Sandbox rules">
          <li>No internet access while the app runs</li>
          <li>Can&apos;t see your files — {limits.files}</li>
          <li>Installing can reach only: {registries.join(", ")}</li>
          <li>Reachable only from this computer, on its own address</li>
          <li>
            {limits.memory} memory, {limits.processes} processes, 1 CPU core
          </li>
          <li>Stopped automatically after {limits.minutes} minutes</li>
        </ul>
        {error && (
          <p role="alert" className="text-sm text-nx-error">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={ghost}>
            Don&apos;t run
          </button>
          <button type="button" onClick={() => void approve()} disabled={busy} className={primary} autoFocus>
            {busy ? "Starting…" : "Approve and run"}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/**
 * Download a finished version, or run it here: the owner approves that exact version,
 * NEXUS installs and starts it in the sandbox, and the log shows what really happened.
 */
export function RunPanel({ app, onRun, onAskFix }: { app: AppDetail; onRun: (run: AppRun) => void; onAskFix: (text: string) => void }) {
  const hostname = useHostname();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const version = app.current;
  const { runtime, run } = app;
  const live = run !== null && RUN_ACTIVE.includes(run.status);
  const other = runtime.active && runtime.active.app_id !== app.id ? runtime.active : null;
  const url = previewUrl(runtime.port, hostname);

  const stop = async () => {
    if (!run) return;
    setBusy(true);
    setError(null);
    try {
      onRun(await stopAppRun(run.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass-solid p-5" aria-labelledby="run-title" data-testid="app-run">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="run-title" className="text-sm font-semibold text-nx-text">
          Use version {version.number}
        </h2>
        <p className="text-xs text-nx-faint">Stored in NEXUS. Download it, or run it here without downloading.</p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <a href={appDownloadUrl(app.id, version.number)} download className={ghost}>
          ⬇ Download .zip
        </a>
        {!live && (
          <button type="button" onClick={() => setAsking(true)} disabled={!runtime.available || other !== null} className={primary}>
            ▶ Run app
          </button>
        )}
        {live && run && (
          <button type="button" onClick={() => void stop()} disabled={busy} className={danger}>
            ■ Stop
          </button>
        )}
        {run?.status === "running" &&
          (url ? (
            <a href={url} target="_blank" rel="noopener noreferrer" className={primary} data-testid="app-open">
              Open app ↗
            </a>
          ) : (
            <span className="text-xs text-nx-warn">The app opens only on the computer NEXUS runs on (http://localhost:{runtime.port}).</span>
          ))}
      </div>
      {!runtime.available && <p className="mt-3 text-xs text-nx-warn">Apps can&apos;t be run on this computer: {runtime.reason ?? "the sandbox isn't available"}.</p>}
      {other && (
        <p className="mt-3 text-xs text-nx-warn">
          “{other.app_name}” is running. One app runs at a time — stop it first.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-nx-error">
          {error}
        </p>
      )}
      {run && (
        <div className="mt-4 space-y-2" data-testid="app-run-result" data-status={run.status}>
          <div className="flex flex-wrap items-center gap-2">
            <RunStatusChip status={run.status} />
            <span className="text-xs text-nx-faint">
              version {run.version}
              {run.status === "running" && url ? ` · ${url}` : ""}
            </span>
          </div>
          {run.error && <p className={`text-xs ${run.status === "failed" ? "text-nx-error" : "text-nx-muted"}`}>{run.error}</p>}
          {run.log && (
            <pre className="max-h-72 overflow-auto rounded-lg bg-black/40 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-nx-text" data-testid="app-run-log" aria-label="Install and app output">
              {run.log}
            </pre>
          )}
          {run.status === "failed" && (
            <button
              type="button"
              onClick={() => onAskFix(`The app did not run: ${run.error ?? "it failed"}\n\nEnd of its output:\n${run.log.slice(-1500)}\n\nPlease fix this.`)}
              className="text-xs text-nx-indigo hover:text-nx-cyan"
            >
              Ask the team to fix this →
            </button>
          )}
        </div>
      )}
      {asking && (
        <ApproveRun
          app={app}
          onClose={() => setAsking(false)}
          onApproved={(started) => {
            setAsking(false);
            onRun(started);
          }}
        />
      )}
    </section>
  );
}
