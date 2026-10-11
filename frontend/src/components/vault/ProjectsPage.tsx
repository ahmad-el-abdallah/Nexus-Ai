"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AppShell } from "@/components/org/AppShell";
import {
  downloadUrl,
  exportEntries,
  fetchProject,
  fetchProjects,
  fetchTextPreview,
  type ProjectFile,
  type ProjectVersion,
  type StorageProject,
  type StorageProjectDetail,
} from "@/lib/storage";

import { DiffView } from "./DiffView";
import { bytes, when } from "./format";
import { VaultTabs } from "./VaultTabs";

const CHANGE_LABEL = { added: "Added", modified: "Modified", unchanged: "Unchanged" } as const;
const CHANGE_STYLE = {
  added: "bg-nx-ok/15 text-nx-ok",
  modified: "bg-nx-warn/15 text-nx-warn",
  unchanged: "bg-white/5 text-nx-faint",
} as const;

function stateLabel(state: string): string {
  if (state === "available") return "Stored";
  if (state === "not_stored") return "Not stored";
  if (state === "trashed") return "In Trash";
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function StatusBadge({ status }: { status: string }) {
  const tone = status === "ready" ? "bg-nx-ok/15 text-nx-ok" : status === "failed" || status === "cancelled" ? "bg-nx-error/15 text-nx-error" : "bg-nx-cyan/10 text-nx-cyan";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] ${tone}`}>{status.replaceAll("_", " ")}</span>;
}

function FileContent({ entryId }: { entryId: string }) {
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void fetchTextPreview(entryId)
      .then((result) => {
        if (active) {
          setText(result.text);
          setTruncated(result.truncated);
        }
      })
      .catch((caught: Error) => active && setError(caught.message));
    return () => {
      active = false;
    };
  }, [entryId]);
  if (error) return <p role="alert" className="p-3 text-xs text-nx-error">{error}</p>;
  return (
    <div>
      {truncated && <p className="px-3 pt-2 text-[10px] text-nx-warn">Preview limited to 256 KiB</p>}
      <pre data-testid="project-file-content" className="max-h-96 overflow-auto p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap text-nx-text">{text ?? "Loading the stored file…"}</pre>
    </div>
  );
}

function FilePanel({ file, version }: { file: ProjectFile; version: ProjectVersion }) {
  const canCompare = file.change === "modified" && Boolean(file.entry_id && file.previous_entry_id) && file.state === "available";
  const [tab, setTab] = useState<"content" | "changes">(canCompare ? "changes" : "content");
  const tabClass = (active: boolean) => `rounded-md px-2.5 py-1 text-[11px] ${active ? "bg-white/10 text-white" : "text-nx-muted hover:bg-white/5"}`;
  return (
    <section aria-label={`Stored file ${file.path}`} className="glass overflow-hidden">
      <header className="flex flex-wrap items-center gap-2 border-b border-nx-line px-3 py-2">
        <h3 className="font-mono text-xs text-nx-text">{file.path}</h3>
        <span className="text-[11px] text-nx-faint">{file.author_name ? `${file.author_name}${file.author_role ? ` · ${file.author_role}` : ""}` : "Author not recorded"}</span>
        {file.entry_id && file.state === "available" && <a href={downloadUrl(file.entry_id)} className="ml-auto rounded-md px-2 py-1 text-[11px] text-nx-text ring-1 ring-nx-line hover:bg-white/10">Download</a>}
      </header>
      {file.purpose && <p className="border-b border-nx-line px-3 py-2 text-[11px] text-nx-muted">{file.purpose}</p>}
      {file.state !== "available" || !file.entry_id ? (
        <p className="p-4 text-xs text-nx-muted">
          {file.state === "not_stored" ? "This file has not been stored in the Vault, so there is nothing to show." : file.state === "trashed" ? "The stored copy of this file is in the Vault's Trash." : `The stored copy of this file is ${file.state}.`}
        </p>
      ) : (
        <>
          <div className="flex gap-1 border-b border-nx-line px-3 py-1.5" role="tablist" aria-label="File view">
            <button role="tab" aria-selected={tab === "content"} onClick={() => setTab("content")} className={tabClass(tab === "content")}>Content</button>
            {version.base_version !== null && (
              <button role="tab" aria-selected={tab === "changes"} onClick={() => setTab("changes")} className={tabClass(tab === "changes")}>Changes since version {version.base_version}</button>
            )}
          </div>
          {tab === "content" ? (
            <FileContent key={file.entry_id} entryId={file.entry_id} />
          ) : canCompare && file.previous_entry_id ? (
            <div className="p-3">
              <DiffView
                key={`${file.previous_entry_id}:${file.entry_id}`}
                request={{ beforeEntry: file.previous_entry_id, afterEntry: file.entry_id }}
                beforeLabel={`Version ${version.base_version}`}
                afterLabel={`Version ${version.number}`}
              />
            </div>
          ) : (
            <p className="p-4 text-xs text-nx-muted">
              {file.change === "added"
                ? `This file is new in version ${version.number}.`
                : file.change === "unchanged"
                  ? `This file is the same as in version ${version.base_version}.`
                  : `The copy from version ${version.base_version} is not available in the Vault, so the two cannot be compared.`}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function ProjectView({ project }: { project: StorageProjectDetail }) {
  const newestReady = [...project.versions].reverse().find((version) => version.status === "ready");
  const [number, setNumber] = useState(newestReady?.number ?? project.versions.at(-1)?.number ?? 0);
  const [path, setPath] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const version = project.versions.find((item) => item.number === number);
  const file = version?.files.find((item) => item.path === path) ?? null;

  return (
    <div className="min-w-0 space-y-4">
      <section className="glass p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-nx-text">{project.name}</h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-nx-muted">{project.description}</p>
          </div>
          <Link href={`/apps/${project.id}`} className="rounded-lg px-3 py-2 text-xs text-nx-text ring-1 ring-nx-line hover:bg-white/5">Open in Apps →</Link>
        </div>
        <div className="mt-4 flex flex-wrap gap-1.5" role="group" aria-label="Versions">
          {project.versions.map((item) => (
            <button
              key={item.id}
              onClick={() => { setNumber(item.number); setPath(null); }}
              aria-pressed={item.number === number}
              className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs ${item.number === number ? "bg-nx-violet/15 text-white ring-1 ring-nx-violet/30" : "text-nx-muted ring-1 ring-nx-line hover:bg-white/5"}`}
            >
              Version {item.number} <StatusBadge status={item.status} />
            </button>
          ))}
        </div>
      </section>

      {version && (
        <section className="glass overflow-hidden" aria-label={`Version ${version.number}`}>
          <div className="border-b border-nx-line p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-nx-muted">
              <span className="font-medium text-nx-text">Version {version.number}</span>
              <StatusBadge status={version.status} />
              {version.stack && <span>{version.stack}</span>}
              {version.finished_at && <span>{when(version.finished_at)}</span>}
              <span data-testid="project-stored-count">{version.stored_file_count} of {version.files.length} files stored · {bytes(version.stored_bytes)}</span>
              {version.folder_id && (
                <button
                  onClick={() => { setExportError(null); void exportEntries([version.folder_id!]).catch((caught: Error) => setExportError(caught.message)); }}
                  className="ml-auto rounded-lg px-3 py-1.5 text-xs text-nx-text ring-1 ring-nx-line hover:bg-white/5"
                >
                  Export version as ZIP
                </button>
              )}
            </div>
            <p className="mt-2 text-xs leading-5 text-nx-muted"><span className="text-nx-faint">Request: </span>{version.request}</p>
            {version.tree_sha256 && <p className="mt-1 font-mono text-[10px] text-nx-faint" title="SHA-256 over every path and file of this version">Content hash {version.tree_sha256.slice(0, 16)}…</p>}
            {exportError && <p role="alert" className="mt-2 text-xs text-nx-error">{exportError}</p>}
          </div>
          {version.status !== "ready" ? (
            <p className="p-5 text-sm text-nx-muted">This version is {version.status.replaceAll("_", " ")}. Only finished (ready) versions are stored in the Vault.</p>
          ) : version.files.length === 0 ? (
            <p className="p-5 text-sm text-nx-muted">This version has no written files.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[10px] tracking-wider text-nx-faint uppercase">
                  <tr><th className="p-2 pl-4">File</th>{version.base_version !== null && <th className="p-2">Since version {version.base_version}</th>}<th className="p-2">Written by</th><th className="p-2">Size</th><th className="p-2">Vault</th></tr>
                </thead>
                <tbody>
                  {version.files.map((item) => (
                    <tr key={item.path} data-testid="project-file" onClick={() => setPath(item.path)} className={`cursor-pointer border-t border-nx-line ${item.path === path ? "bg-nx-violet/10" : "hover:bg-white/[0.035]"}`}>
                      <td className="p-2 pl-4"><button onClick={() => setPath(item.path)} className="font-mono text-nx-text hover:underline">{item.path}</button></td>
                      {version.base_version !== null && <td className="p-2">{item.change && <span className={`rounded px-1.5 py-0.5 text-[10px] ${CHANGE_STYLE[item.change]}`}>{CHANGE_LABEL[item.change]}</span>}</td>}
                      <td className="p-2 text-nx-muted">{item.author_name ?? "—"}</td>
                      <td className="p-2 whitespace-nowrap text-nx-muted">{bytes(item.size_bytes)}</td>
                      <td className={`p-2 whitespace-nowrap ${item.state === "available" ? "text-nx-muted" : "text-nx-warn"}`}>{stateLabel(item.state)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {version.removed.length > 0 && (
            <p className="border-t border-nx-line px-4 py-3 text-xs text-nx-muted">
              Removed since version {version.base_version}: {version.removed.map((item) => <code key={item} className="mr-2 font-mono text-nx-text">{item}</code>)}
            </p>
          )}
        </section>
      )}

      {version && file ? (
        <FilePanel key={`${version.id}:${file.path}`} file={file} version={version} />
      ) : (
        version?.status === "ready" && version.files.length > 0 && <p className="px-1 text-xs text-nx-faint">Select a file to read the stored copy and see what changed.</p>
      )}
    </div>
  );
}

/** Engineering apps as the Vault stores them: versions, files and real changes between versions. */
export function ProjectsPage() {
  const [projects, setProjects] = useState<StorageProject[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StorageProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchProjects()
      .then((rows) => {
        setProjects(rows);
        setSelectedId((current) => current ?? rows[0]?.id ?? null);
      })
      .catch((caught: Error) => setError(caught.message));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    void fetchProject(selectedId)
      .then((value) => active && setDetail(value))
      .catch((caught: Error) => active && setError(caught.message));
    return () => {
      active = false;
    };
  }, [selectedId]);

  return (
    <AppShell title="Digital Vault" subtitle="Engineering projects as stored: every finished app version, its files, who wrote them and what changed.">
      <VaultTabs />
      {error && <p role="alert" className="rounded-xl bg-nx-error/10 px-4 py-3 text-sm text-nx-error ring-1 ring-nx-error/30">{error}</p>}
      {projects === null && !error ? (
        <p role="status" className="glass p-8 text-center text-sm text-nx-muted">Loading engineering projects…</p>
      ) : projects && projects.length === 0 ? (
        <div className="glass grid min-h-72 place-items-center p-8 text-center">
          <div>
            <h2 className="font-medium text-nx-text">No engineering projects yet</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-nx-muted">When the engineering team builds an app, each finished version is stored here with its files. Nothing is shown until that has really happened.</p>
            <Link href="/apps" className="mt-4 inline-block rounded-lg bg-nx-violet px-4 py-2 text-xs font-medium text-white">Go to Apps</Link>
          </div>
        </div>
      ) : projects ? (
        <div className="grid min-w-0 gap-4 lg:grid-cols-[250px_minmax(0,1fr)]">
          <aside className="glass max-h-80 min-w-0 overflow-y-auto p-3 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:self-start" aria-label="Engineering projects">
            <p className="px-2 pt-1 text-[10px] tracking-[0.18em] text-nx-faint uppercase">Projects · {projects.length}</p>
            <nav className="mt-2 space-y-1">
              {projects.map((project) => (
                <button
                  key={project.id}
                  data-project-id={project.id}
                  onClick={() => { if (project.id !== selectedId) { setDetail(null); setSelectedId(project.id); } }}
                  aria-current={project.id === selectedId ? "page" : undefined}
                  className={`w-full rounded-lg px-3 py-2 text-left ${project.id === selectedId ? "bg-white/[0.07] ring-1 ring-nx-line-strong" : "hover:bg-white/[0.04]"}`}
                >
                  <span className="flex items-center justify-between gap-2"><span className="truncate text-xs text-nx-text">{project.name}</span>{project.latest_status && <StatusBadge status={project.latest_status} />}</span>
                  <span className="mt-1 block text-[10px] text-nx-faint">{project.ready_version_count} of {project.version_count} version{project.version_count === 1 ? "" : "s"} ready · {project.stored_file_count} files · {bytes(project.stored_bytes)}</span>
                </button>
              ))}
            </nav>
            <p className="mt-4 px-2 text-[10px] leading-4 text-nx-faint">A project here is an app built by Engineering. Company-wide projects are planned for a later stage.</p>
          </aside>
          {detail && detail.id === selectedId ? <ProjectView key={`${detail.id}:${detail.updated_at}`} project={detail} /> : <p role="status" className="glass p-8 text-center text-sm text-nx-muted">Loading the stored versions…</p>}
        </div>
      ) : null}
    </AppShell>
  );
}
