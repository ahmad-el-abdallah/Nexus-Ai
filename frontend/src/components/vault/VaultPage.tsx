"use client";

import Link from "next/link";
import { type ChangeEvent, type FormEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { AppShell } from "@/components/org/AppShell";
import {
  createFolder,
  downloadUrl,
  duplicateEntry,
  exportEntries,
  fetchEntries,
  fetchEntry,
  fetchTextPreview,
  fetchWorkspaces,
  permanentlyDeleteEntry,
  previewUrl,
  restoreEntry,
  searchEntries,
  trashEntry,
  updateEntry,
  uploadFile,
  type StorageEntry,
  type StorageEntryDetail,
  type StorageWorkspace,
} from "@/lib/storage";

type Mode = "all" | "folder" | "recent" | "generated" | "favorites" | "trash";
type View = "grid" | "list";
type Sort = "name" | "created" | "updated" | "type";

const PAGE_SIZE = 50;

function bytes(value: number | null): string {
  if (value === null) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = value / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function when(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function workspaceName(workspace: StorageWorkspace): string {
  if (workspace.scope === "company") return "Company Vault";
  return (workspace.department_key ?? "Department").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function icon(entry: StorageEntry): string {
  if (entry.kind === "folder") return "▰";
  if (entry.preview_kind === "image") return "◫";
  if (entry.preview_kind === "audio") return "♫";
  if (entry.preview_kind === "video") return "▶";
  if (entry.preview_kind === "pdf") return "PDF";
  if (entry.preview_kind === "text" || entry.preview_kind === "csv") return "≡";
  return "◇";
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length && rows.length < 50; index += 1) {
    const character = text[index]!;
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

function Preview({ detail }: { detail: StorageEntryDetail }) {
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (detail.trashed_at || (detail.preview_kind !== "text" && detail.preview_kind !== "csv")) return;
    let active = true;
    void fetchTextPreview(detail.id)
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
  }, [detail.id, detail.preview_kind, detail.trashed_at]);

  if (detail.kind === "folder") return <p className="p-5 text-sm text-nx-muted">Folder metadata is shown below. Open it to browse its contents.</p>;
  if (detail.trashed_at) return <p className="p-5 text-sm text-nx-muted">Restore this item to preview or download its contents.</p>;
  if (error) return <p role="alert" className="p-5 text-sm text-nx-error">{error}</p>;
  if (detail.preview_kind === "text") {
    return (
      <div className="relative">
        {truncated && <span className="absolute top-2 right-2 rounded bg-nx-warn/15 px-2 py-1 text-[10px] text-nx-warn">Preview limited to 256 KiB</span>}
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-5 text-nx-text">{text ?? "Loading preview…"}</pre>
      </div>
    );
  }
  if (detail.preview_kind === "csv") {
    const rows = csvRows(text ?? "");
    return (
      <div className="max-h-80 overflow-auto p-3">
        {truncated && <p className="mb-2 text-[10px] text-nx-warn">Preview limited to 256 KiB</p>}
        <table className="w-full border-collapse text-left text-xs">
          <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="border border-nx-line px-2 py-1.5 text-nx-muted">{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
  if (detail.preview_kind === "image") return (
    <div className="grid min-h-48 place-items-center bg-black/20 p-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={previewUrl(detail.id)} alt={`Preview of ${detail.name}`} className="max-h-72 max-w-full rounded-lg object-contain" />
    </div>
  );
  if (detail.preview_kind === "pdf") return <iframe title={`Preview of ${detail.name}`} sandbox="" src={previewUrl(detail.id)} className="h-80 w-full bg-white" />;
  if (detail.preview_kind === "audio") return <div className="p-5"><audio controls preload="metadata" className="w-full" src={previewUrl(detail.id)} /></div>;
  if (detail.preview_kind === "video") return <div className="p-4"><video controls preload="metadata" className="max-h-72 w-full rounded-lg bg-black" src={previewUrl(detail.id)} /></div>;
  return <p className="p-5 text-sm text-nx-muted">Safe inline preview is unavailable for this format. Metadata and download remain available.</p>;
}

interface InspectorProps {
  detail: StorageEntryDetail;
  workspaces: StorageWorkspace[];
  folders: StorageEntry[];
  busy: boolean;
  onAction: (action: () => Promise<unknown>, clear?: boolean) => void;
}

function Inspector({ detail, workspaces, folders, busy, onAction }: InspectorProps) {
  const [name, setName] = useState(detail.name);
  const [description, setDescription] = useState(detail.description ?? "");
  const [tags, setTags] = useState(detail.tags.filter((tag) => tag.toLowerCase() !== "favorite").join(", "));
  const [destination, setDestination] = useState(detail.parent_id ?? "");
  const [copyWorkspace, setCopyWorkspace] = useState(detail.workspace_id);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [confirmPermanent, setConfirmPermanent] = useState(false);
  const save = () => onAction(() => updateEntry(detail.id, { name, description, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean).concat(detail.favorite ? ["favorite"] : []) }));
  const favoriteTags = detail.favorite ? detail.tags.filter((tag) => tag.toLowerCase() !== "favorite") : [...detail.tags, "favorite"];
  return (
    <aside className="glass min-w-0 lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)] lg:overflow-y-auto" aria-label="Item details">
      <div className="border-b border-nx-line p-4">
        <p className="text-[10px] tracking-[0.18em] text-nx-faint uppercase">{detail.kind} · {detail.status}</p>
        <h2 className="mt-1 truncate text-lg font-semibold text-nx-text">{detail.name}</h2>
        <p className="mt-1 truncate font-mono text-[11px] text-nx-faint">{detail.path}</p>
      </div>
      <div className="border-b border-nx-line bg-black/10"><Preview key={detail.id} detail={detail} /></div>
      <div className="space-y-3 p-4">
        {!detail.trashed_at && <>
          <label className="block text-[11px] text-nx-muted">Name<input aria-label="Item name" value={name} onChange={(event) => setName(event.target.value)} className="mt-1 w-full rounded-lg bg-black/20 px-3 py-2 text-sm text-nx-text ring-1 ring-nx-line outline-none focus:ring-nx-violet" /></label>
          <label className="block text-[11px] text-nx-muted">Description<textarea aria-label="Description" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} className="mt-1 w-full resize-none rounded-lg bg-black/20 px-3 py-2 text-sm text-nx-text ring-1 ring-nx-line outline-none focus:ring-nx-violet" /></label>
          <label className="block text-[11px] text-nx-muted">Tags<input aria-label="Tags" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="release, report" className="mt-1 w-full rounded-lg bg-black/20 px-3 py-2 text-sm text-nx-text ring-1 ring-nx-line outline-none focus:ring-nx-violet" /></label>
          <button disabled={busy || !name.trim()} onClick={save} className="w-full rounded-lg bg-nx-violet px-3 py-2 text-sm font-medium text-white disabled:opacity-40">Save metadata</button>
        </>}
        <div className="grid grid-cols-2 gap-2 text-xs">
          {detail.kind === "file" && !detail.trashed_at && <a href={downloadUrl(detail.id)} className="rounded-lg bg-white/5 px-3 py-2 text-center text-nx-text ring-1 ring-nx-line hover:bg-white/10">Download</a>}
          {!detail.trashed_at && <button disabled={busy} onClick={() => onAction(() => updateEntry(detail.id, { tags: favoriteTags }))} className="rounded-lg bg-white/5 px-3 py-2 text-nx-text ring-1 ring-nx-line hover:bg-white/10">{detail.favorite ? "Unfavorite" : "Favorite"}</button>}
          {!detail.trashed_at && <button disabled={busy} onClick={() => onAction(() => duplicateEntry(detail.id, { destination_parent_id: detail.parent_id }))} className="rounded-lg bg-white/5 px-3 py-2 text-nx-text ring-1 ring-nx-line hover:bg-white/10">Duplicate</button>}
          {!detail.trashed_at && <button disabled={busy} onClick={() => onAction(() => exportEntries([detail.id]))} className="rounded-lg bg-white/5 px-3 py-2 text-nx-text ring-1 ring-nx-line hover:bg-white/10">Export ZIP</button>}
        </div>
        {!detail.trashed_at && <div className="rounded-xl bg-white/[0.025] p-3 ring-1 ring-nx-line">
          <label className="text-[11px] text-nx-muted">Move to folder<select aria-label="Move destination" value={destination} onChange={(event) => setDestination(event.target.value)} className="mt-1 w-full rounded-lg bg-nx-bg-raised px-2 py-2 text-xs text-nx-text ring-1 ring-nx-line"><option value="">Workspace root</option>{folders.filter((folder) => folder.id !== detail.id).map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}</select></label>
          <button disabled={busy || destination === (detail.parent_id ?? "")} onClick={() => onAction(() => updateEntry(detail.id, { parent_id: destination || null }))} className="mt-2 w-full rounded-lg px-3 py-2 text-xs text-nx-text ring-1 ring-nx-line disabled:opacity-40">Move</button>
        </div>}
        {!detail.trashed_at && <div className="rounded-xl bg-white/[0.025] p-3 ring-1 ring-nx-line">
          <label className="text-[11px] text-nx-muted">Copy to workspace<select aria-label="Copy destination workspace" value={copyWorkspace} onChange={(event) => setCopyWorkspace(event.target.value)} className="mt-1 w-full rounded-lg bg-nx-bg-raised px-2 py-2 text-xs text-nx-text ring-1 ring-nx-line">{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspaceName(workspace)}</option>)}</select></label>
          <button disabled={busy} onClick={() => onAction(() => duplicateEntry(detail.id, { destination_workspace_id: copyWorkspace, destination_parent_id: null }))} className="mt-2 w-full rounded-lg px-3 py-2 text-xs text-nx-text ring-1 ring-nx-line">Copy to root</button>
        </div>}
        {detail.trashed_at ? <div className="grid grid-cols-2 gap-2 text-xs">
          <button disabled={busy} onClick={() => onAction(() => restoreEntry(detail.id), true)} className="rounded-lg bg-nx-ok/15 px-3 py-2 text-nx-ok ring-1 ring-nx-ok/30">Restore</button>
          <button disabled={busy} onClick={() => confirmPermanent ? onAction(() => permanentlyDeleteEntry(detail.id), true) : setConfirmPermanent(true)} className="rounded-lg bg-nx-error/10 px-3 py-2 text-nx-error ring-1 ring-nx-error/30">{confirmPermanent ? "Confirm permanent delete" : "Delete permanently"}</button>
        </div> : <button disabled={busy} onClick={() => confirmTrash ? onAction(() => trashEntry(detail.id), true) : setConfirmTrash(true)} className="w-full rounded-lg bg-nx-error/10 px-3 py-2 text-xs text-nx-error ring-1 ring-nx-error/30">{confirmTrash ? "Confirm move to Trash" : "Move to Trash"}</button>}
      </div>
      <dl className="grid grid-cols-2 gap-px border-y border-nx-line bg-nx-line text-xs">
        {[['Owner', detail.owner_name], ['Creator', detail.created_by_name ?? detail.created_by_kind], ['Size', bytes(detail.size_bytes)], ['Updated', when(detail.updated_at)], ['Visibility', detail.visibility], ['Checksum', detail.sha256 ? `${detail.sha256.slice(0, 12)}…` : '—']].map(([label, value]) => <div key={label} className="min-w-0 bg-nx-bg-raised/80 p-3"><dt className="text-[9px] tracking-wider text-nx-faint uppercase">{label}</dt><dd className="mt-1 truncate text-nx-muted" title={value}>{value}</dd></div>)}
      </dl>
      <div className="space-y-4 p-4 text-xs">
        <section><h3 className="font-medium text-nx-text">Versions · {detail.versions.length}</h3>{detail.versions.length ? <ul className="mt-2 space-y-1 text-nx-muted">{detail.versions.map((version) => <li key={version.id}>v{version.number} · {bytes(version.size_bytes)} · {version.status}</li>)}</ul> : <p className="mt-1 text-nx-faint">Folders have no versions.</p>}</section>
        <section><h3 className="font-medium text-nx-text">Linked work · {detail.links.length}</h3>{detail.links.length ? <ul className="mt-2 space-y-1 text-nx-muted">{detail.links.map((link) => <li key={link.id}>{link.target_type.replace('_', ' ')} · {link.label ?? link.target_id}</li>)}</ul> : <p className="mt-1 text-nx-faint">No source links.</p>}</section>
        <section><h3 className="font-medium text-nx-text">Activity</h3><ul className="mt-2 space-y-2">{detail.events.slice(0, 8).map((event) => <li key={event.id}><p className="text-nx-muted">{event.text}</p><p className="text-[10px] text-nx-faint">{event.actor_name ?? "System"} · {when(event.created_at)}</p></li>)}</ul></section>
      </div>
    </aside>
  );
}

export function VaultPage() {
  const [workspaces, setWorkspaces] = useState<StorageWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [mode, setMode] = useState<Mode>("all");
  const [parentId, setParentId] = useState<string | null>(null);
  const [crumbs, setCrumbs] = useState<StorageEntry[]>([]);
  const [entries, setEntries] = useState<StorageEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [kind, setKind] = useState<"" | "folder" | "file">("");
  const [sort, setSort] = useState<Sort>("updated");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [view, setView] = useState<View>("grid");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<StorageEntryDetail | null>(null);
  const [folders, setFolders] = useState<StorageEntry[]>([]);
  const [newFolder, setNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void fetchWorkspaces().then((rows) => {
      setWorkspaces(rows);
      setWorkspaceId((current) => current || rows.find((row) => row.id === "ws_company")?.id || rows[0]?.id || "");
    }).catch((caught: Error) => { setError(caught.message); setLoad("error"); });
  }, []);

  const searchMode = mode !== "folder" || Boolean(deferredQuery.trim());
  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    const operation = searchMode
      ? searchEntries({ workspace_id: workspaceId, q: deferredQuery.trim() || undefined, kind: kind || undefined, tag: mode === "favorites" ? "favorite" : mode === "generated" ? "ai-generated" : undefined, trashed: mode === "trash", sort: mode === "recent" ? "updated" : sort, order: mode === "recent" ? "desc" : order, limit: PAGE_SIZE })
      : fetchEntries(workspaceId, parentId).then((items) => ({ items, total: items.length, offset: 0, limit: items.length }));
    void operation.then((result) => {
      if (!active) return;
      let items = result.items;
      if (!searchMode) {
        if (kind) items = items.filter((entry) => entry.kind === kind);
        items = [...items].sort((left, right) => {
          const a = sort === "name" ? left.name : sort === "created" ? left.created_at : sort === "type" ? left.kind : left.updated_at;
          const b = sort === "name" ? right.name : sort === "created" ? right.created_at : sort === "type" ? right.kind : right.updated_at;
          return a.localeCompare(b) * (order === "asc" ? 1 : -1);
        });
      }
      setEntries(items);
      setTotal(result.total);
      setLoad("ready");
      setSelectedIds(new Set());
    }).catch((caught: Error) => { if (active) { setError(caught.message); setLoad("error"); } });
    return () => { active = false; };
  }, [workspaceId, mode, parentId, deferredQuery, kind, sort, order, revision, searchMode]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    void fetchEntry(selectedId).then((value) => active && setDetail(value)).catch((caught: Error) => active && setError(caught.message));
    return () => { active = false; };
  }, [selectedId, revision]);

  useEffect(() => {
    if (!workspaceId) return;
    void searchEntries({ workspace_id: workspaceId, kind: "folder", sort: "name", order: "asc", limit: 100 }).then((result) => setFolders(result.items)).catch(() => setFolders([]));
  }, [workspaceId, revision]);

  const currentWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  const selected = useMemo(() => Array.from(selectedIds), [selectedIds]);
  const refresh = () => setRevision((value) => value + 1);
  const act = (action: () => Promise<unknown>, clear = false) => {
    setBusy(true);
    setError(null);
    void action().then(() => { if (clear) { setSelectedId(null); setDetail(null); } refresh(); }).catch((caught: Error) => setError(caught.message)).finally(() => setBusy(false));
  };
  const chooseMode = (next: Mode) => { setMode(next); setParentId(null); setCrumbs([]); setSelectedId(null); setDetail(null); setQuery(""); };
  const openFolder = (entry: StorageEntry) => { setMode("folder"); setParentId(entry.id); setCrumbs((current) => [...current.filter((crumb) => entry.path.startsWith(crumb.path)), entry]); setSelectedId(null); setDetail(null); };
  const workspaceChange = (id: string) => { setWorkspaceId(id); chooseMode("all"); };
  const toggleSelected = (id: string) => setSelectedIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const addFolder = (event: FormEvent) => { event.preventDefault(); if (!newFolderName.trim()) return; act(() => createFolder(workspaceId, newFolderName, mode === "folder" ? parentId : null).then(() => { setNewFolderName(""); setNewFolder(false); })); };
  const upload = (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file) act(() => uploadFile(workspaceId, file, mode === "folder" ? parentId : null)); event.target.value = ""; };
  const loadMore = () => {
    setBusy(true);
    setError(null);
    void searchEntries({ workspace_id: workspaceId, q: deferredQuery.trim() || undefined, kind: kind || undefined, tag: mode === "favorites" ? "favorite" : mode === "generated" ? "ai-generated" : undefined, trashed: mode === "trash", sort: mode === "recent" ? "updated" : sort, order: mode === "recent" ? "desc" : order, offset: entries.length, limit: PAGE_SIZE })
      .then((result) => setEntries((current) => [...current, ...result.items]))
      .catch((caught: Error) => setError(caught.message))
      .finally(() => setBusy(false));
  };

  return (
    <AppShell title="Digital Vault" subtitle="Persistent company artifacts with permission-enforced storage, safe previews and verified downloads." actions={<Link href="/" className="rounded-xl px-4 py-2 text-sm text-nx-muted ring-1 ring-nx-line hover:bg-white/5 hover:text-nx-text">Return to Data Center</Link>}>
      {error && <div role="alert" className="flex items-center justify-between rounded-xl bg-nx-error/10 px-4 py-3 text-sm text-nx-error ring-1 ring-nx-error/30"><span>{error}</span><button onClick={() => setError(null)}>Dismiss</button></div>}
      <div className="grid min-w-0 gap-4 lg:grid-cols-[210px_minmax(0,1fr)_330px]">
        <aside className="glass max-h-[28rem] min-w-0 overflow-y-auto p-3 lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)] lg:max-h-none" aria-label="Vault navigation">
          <p className="px-2 pt-1 text-[10px] tracking-[0.18em] text-nx-faint uppercase">Views</p>
          <nav className="mt-2 space-y-1">{([['all', 'All files', '◇'], ['recent', 'Recent', '◷'], ['generated', 'AI generated', '✦'], ['favorites', 'Favorites', '★'], ['trash', 'Trash', '⌫']] as const).map(([value, label, mark]) => <button key={value} onClick={() => chooseMode(value)} aria-current={mode === value ? "page" : undefined} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${mode === value ? 'bg-nx-violet/15 text-white ring-1 ring-nx-violet/30' : 'text-nx-muted hover:bg-white/5'}`}><span className="w-4 text-center text-nx-cyan">{mark}</span>{label}</button>)}</nav>
          <p className="mt-5 px-2 text-[10px] tracking-[0.18em] text-nx-faint uppercase">Workspaces</p>
          <nav className="mt-2 space-y-1">{workspaces.map((workspace) => <button key={workspace.id} onClick={() => workspaceChange(workspace.id)} className={`w-full rounded-lg px-3 py-2 text-left ${workspaceId === workspace.id ? 'bg-white/[0.07] ring-1 ring-nx-line-strong' : 'hover:bg-white/[0.04]'}`}><span className="block truncate text-xs text-nx-text">{workspaceName(workspace)}</span><span className="mt-1 block text-[10px] text-nx-faint">{bytes(workspace.used_bytes)} / {bytes(workspace.quota_bytes)}{workspace.state === 'read_only' ? ' · read-only' : ''}</span></button>)}</nav>
        </aside>

        <main className="min-w-0">
          <section className="glass overflow-hidden">
            <div className="border-b border-nx-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <label className="min-w-48 flex-1"><span className="sr-only">Search vault</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search names, descriptions, owners, tags or links…" className="w-full rounded-xl bg-black/20 px-4 py-2.5 text-sm text-nx-text ring-1 ring-nx-line outline-none placeholder:text-nx-faint focus:ring-nx-violet" /></label>
                <select aria-label="Filter type" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} className="rounded-xl bg-nx-bg-raised px-3 py-2.5 text-xs text-nx-muted ring-1 ring-nx-line"><option value="">All types</option><option value="folder">Folders</option><option value="file">Files</option></select>
                <select aria-label="Sort files" value={sort} onChange={(event) => setSort(event.target.value as Sort)} className="rounded-xl bg-nx-bg-raised px-3 py-2.5 text-xs text-nx-muted ring-1 ring-nx-line"><option value="updated">Updated</option><option value="name">Name</option><option value="created">Created</option><option value="type">Type</option></select>
                <button aria-label={`Sort ${order === 'asc' ? 'descending' : 'ascending'}`} onClick={() => setOrder((value) => value === 'asc' ? 'desc' : 'asc')} className="rounded-xl px-3 py-2.5 text-xs text-nx-muted ring-1 ring-nx-line">{order === 'asc' ? '↑' : '↓'}</button>
                <div className="flex rounded-xl ring-1 ring-nx-line"><button aria-pressed={view === 'grid'} onClick={() => setView('grid')} className={`px-3 py-2 text-xs ${view === 'grid' ? 'bg-white/10 text-white' : 'text-nx-muted'}`}>Grid</button><button aria-pressed={view === 'list'} onClick={() => setView('list')} className={`px-3 py-2 text-xs ${view === 'list' ? 'bg-white/10 text-white' : 'text-nx-muted'}`}>List</button></div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <button onClick={() => { setMode('folder'); setParentId(null); setCrumbs([]); }} className="text-nx-muted hover:text-white">{workspaceName(currentWorkspace ?? { id: '', scope: 'company', department_key: null, state: 'active', used_bytes: 0, quota_bytes: 0, quota_override_bytes: null })}</button>
                {crumbs.map((crumb, index) => <span key={crumb.id} className="flex items-center gap-2"><span className="text-nx-faint">/</span><button onClick={() => { setMode('folder'); setParentId(crumb.id); setCrumbs(crumbs.slice(0, index + 1)); }} className="text-nx-muted hover:text-white">{crumb.name}</button></span>)}
                <span className="ml-auto text-nx-faint">{total} item{total === 1 ? '' : 's'}</span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-b border-nx-line px-3 py-2">
              <button disabled={!workspaceId || currentWorkspace?.state === 'read_only' || mode === 'trash' || mode === 'generated'} onClick={() => setNewFolder((value) => !value)} className="rounded-lg bg-nx-violet px-3 py-2 text-xs font-medium text-white disabled:opacity-40">+ New folder</button>
              <button disabled={!workspaceId || currentWorkspace?.state === 'read_only' || mode === 'trash' || mode === 'generated'} onClick={() => uploadRef.current?.click()} className="rounded-lg bg-nx-cyan/10 px-3 py-2 text-xs font-medium text-nx-cyan ring-1 ring-nx-cyan/30 disabled:opacity-40">Upload file</button>
              <input ref={uploadRef} type="file" className="hidden" onChange={upload} />
              {selected.length > 0 && <><button disabled={busy} onClick={() => act(() => exportEntries(selected))} className="rounded-lg px-3 py-2 text-xs text-nx-text ring-1 ring-nx-line">Export {selected.length} as ZIP</button><button onClick={() => setSelectedIds(new Set())} className="text-xs text-nx-faint">Clear selection</button></>}
              {busy && <span role="status" className="ml-auto text-xs text-nx-cyan">Applying operation…</span>}
            </div>
            {newFolder && <form onSubmit={addFolder} className="flex gap-2 border-b border-nx-line bg-nx-violet/5 p-3"><input autoFocus aria-label="New folder name" value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} placeholder="Folder name" className="min-w-0 flex-1 rounded-lg bg-black/20 px-3 py-2 text-sm ring-1 ring-nx-line outline-none" /><button className="rounded-lg bg-nx-violet px-3 py-2 text-xs">Create</button><button type="button" onClick={() => setNewFolder(false)} className="px-2 text-xs text-nx-muted">Cancel</button></form>}
            <div className="min-h-[34rem] p-3">
              {load === 'loading' ? <p role="status" className="p-8 text-center text-sm text-nx-muted">Loading real Vault metadata…</p> : load === 'error' ? <p className="p-8 text-center text-sm text-nx-error">Vault contents unavailable.</p> : entries.length === 0 ? <div className="grid min-h-80 place-items-center text-center"><div><div className="mx-auto grid size-16 place-items-center rounded-2xl bg-nx-violet/10 text-3xl text-nx-violet ring-1 ring-nx-violet/25">◇</div><h2 className="mt-4 font-medium text-nx-text">{mode === 'generated' ? 'No AI artifacts yet' : 'Nothing stored here yet'}</h2><p className="mt-1 text-sm text-nx-muted">{mode === 'generated' ? 'Completed employee work appears here automatically with its provenance.' : 'Upload a real file or create a folder. No samples are fabricated.'}</p></div></div> : view === 'grid' ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{entries.map((entry) => <article key={entry.id} data-testid="vault-item" className={`group relative rounded-xl bg-white/[0.025] p-3 ring-1 transition ${selectedId === entry.id ? 'ring-nx-violet bg-nx-violet/10' : 'ring-nx-line hover:bg-white/[0.05]'}`}><input type="checkbox" aria-label={`Select ${entry.name}`} checked={selectedIds.has(entry.id)} onChange={() => toggleSelected(entry.id)} className="absolute top-3 right-3 accent-violet-500" /><button onClick={() => setSelectedId(entry.id)} onDoubleClick={() => entry.kind === 'folder' && openFolder(entry)} className="w-full text-left"><span className={`grid size-11 place-items-center rounded-xl text-sm font-semibold ${entry.kind === 'folder' ? 'bg-nx-violet/15 text-nx-violet' : 'bg-nx-cyan/10 text-nx-cyan'}`}>{icon(entry)}</span><span className="mt-3 block truncate text-sm font-medium text-nx-text">{entry.name}</span><span className="mt-1 block truncate text-[11px] text-nx-faint">{entry.kind === 'folder' ? entry.path : `${bytes(entry.size_bytes)} · ${entry.mime_type ?? 'file'}`}</span></button>{entry.kind === 'folder' && <button onClick={() => openFolder(entry)} aria-label={`Open folder ${entry.name}`} className="mt-3 text-[11px] font-medium text-nx-cyan">Open folder →</button>}{entry.favorite && <span className="absolute right-9 top-3 text-nx-warn">★</span>}</article>)}</div> : <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-[10px] tracking-wider text-nx-faint uppercase"><tr><th className="w-8 p-2"></th><th className="p-2">Name</th><th className="p-2">Type</th><th className="p-2">Size</th><th className="p-2">Updated</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.id} data-testid="vault-item" onClick={() => setSelectedId(entry.id)} onDoubleClick={() => entry.kind === 'folder' && openFolder(entry)} className={`cursor-pointer border-t border-nx-line ${selectedId === entry.id ? 'bg-nx-violet/10' : 'hover:bg-white/[0.035]'}`}><td className="p-2"><input type="checkbox" aria-label={`Select ${entry.name}`} checked={selectedIds.has(entry.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggleSelected(entry.id)} /></td><td className="max-w-48 truncate p-2 text-nx-text">{entry.favorite && <span className="mr-1 text-nx-warn">★</span>}{entry.name}</td><td className="p-2 text-nx-muted">{entry.kind === 'folder' ? 'Folder' : entry.mime_type}</td><td className="p-2 text-nx-muted">{bytes(entry.size_bytes)}</td><td className="p-2 text-nx-muted">{when(entry.updated_at)}</td></tr>)}</tbody></table></div>}
              {searchMode && entries.length < total && <button disabled={busy} onClick={loadMore} className="mx-auto mt-4 block rounded-lg px-4 py-2 text-xs text-nx-muted ring-1 ring-nx-line hover:bg-white/5">Load next {Math.min(PAGE_SIZE, total - entries.length)}</button>}
            </div>
          </section>
        </main>
        {detail ? <Inspector key={`${detail.id}:${detail.updated_at}`} detail={detail} workspaces={workspaces} folders={folders} busy={busy} onAction={act} /> : <aside className="glass min-h-72 p-5 text-sm text-nx-muted lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)] lg:overflow-y-auto">Select an item to inspect its safe preview, metadata, versions, links and activity.</aside>}
      </div>
    </AppShell>
  );
}
