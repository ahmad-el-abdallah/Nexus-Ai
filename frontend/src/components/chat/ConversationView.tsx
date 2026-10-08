"use client";

import Link from "next/link";
import { type ChangeEvent, type FormEvent, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Initials } from "@/components/hq/people";
import { useChatVoice } from "@/components/voice/useChatVoice";
import { attachmentUrl, type Conversation, formatBytes, MAX_FILE_BYTES, MAX_FILES, type Message, type ReplyState } from "@/lib/chat";
import { type Addressee, responderFor } from "@/lib/routing";
import { speechPlayer } from "@/lib/speech";
import { installed } from "@/lib/voice";
import { STATUS_META } from "@/world/characters/status";
import { useChatStore } from "@/world/state/chatStore";
import { useDepartmentStore } from "@/world/state/departmentStore";
import { useEmployeeStore } from "@/world/state/employeeStore";
import { useVoiceStore } from "@/world/state/voiceStore";

import { TargetAvatar, useTargetName } from "./ConversationList";
import { Markdown } from "./Markdown";
import { type TaskSource, TaskDialog } from "./TaskDialog";

const NO_MESSAGES: Message[] = [];

const REPLY_STATE_TEXT: Record<Exclude<ReplyState, "done">, string> = {
  queued: "Waiting for a free model slot…",
  generating: "Request sent — waiting for the first words…",
  thinking: "Thinking — the model is reasoning (its reasoning isn't shown)…",
  writing: "Writing…",
};

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|toml|ini|cfg|log|xml|html?|css|jsx?|tsx?|py|sql|sh|rs|go|java|kt|c|h|cpp|rb|php|svg)$/i;
const looksReadable = (f: File) => f.type.startsWith("text/") || TEXT_EXT.test(f.name) || /json|xml|yaml|toml|javascript|sql/.test(f.type);

function time(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function MessageMeta({ m }: { m: Message }) {
  if (m.role !== "agent" || m.status === "streaming" || !m.model) return null;
  const parts = [
    m.model,
    m.prompt_tokens != null || m.completion_tokens != null ? `${m.prompt_tokens ?? "—"} in / ${m.completion_tokens ?? "—"} out tokens${m.reasoning_tokens ? ` (${m.reasoning_tokens} reasoning)` : ""}` : null,
    m.first_token_ms != null ? `first token ${m.first_token_ms} ms` : null,
    m.latency_ms != null ? `total ${(m.latency_ms / 1000).toFixed(1)} s` : null,
    m.context_messages != null ? `context: ${m.context_messages} message${m.context_messages === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return <p className="mt-2 font-mono text-[10px] leading-4 text-nx-faint">{parts.join(" · ")}</p>;
}

function AgentAvatar({ m }: { m: Message }) {
  const employee = useEmployeeStore((s) => s.employees.find((e) => e.id === m.employee_id));
  if (employee) return <Initials employee={employee} size="size-8" />;
  return (
    <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-white/10 text-[10px] font-bold text-nx-muted">
      {(m.author_name ?? "?").slice(0, 1)}
    </span>
  );
}

function MessageItem({
  m,
  state,
  isLast,
  onTask,
  onRetry,
  busy,
  highlight,
  speaking,
  canListen,
}: {
  m: Message;
  state: ReplyState | null;
  isLast: boolean;
  onTask: (m: Message) => void;
  onRetry: () => void;
  busy: boolean;
  highlight: boolean;
  /** This message is being read aloud ("loading" | "speaking") or not. */
  speaking: string | null;
  canListen: boolean;
}) {
  const departmentName = useDepartmentStore((s) => s.departments.find((d) => d.key === m.author_department)?.name);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (e.g. insecure context) */
    }
  };
  const actions = (m.content.trim() || m.attachments.length > 0) && m.status !== "streaming" && (
    <div className="mt-1.5 flex gap-3 text-[11px] text-nx-faint opacity-80 group-hover:opacity-100">
      <button type="button" onClick={() => onTask(m)} className="hover:text-nx-cyan">
        Create task
      </button>
      {m.content.trim() && (
        <button type="button" onClick={copy} className="hover:text-nx-cyan">
          {copied ? "Copied" : "Copy"}
        </button>
      )}
      {m.role === "agent" && m.status === "complete" && canListen && (
        <button
          type="button"
          onClick={() => (speaking ? speechPlayer.stop() : void speechPlayer.play(m.id))}
          className={speaking ? "text-nx-cyan" : "hover:text-nx-cyan"}
          aria-label={speaking ? "Stop reading aloud" : "Listen to this reply"}
        >
          {speaking === "loading" ? "Preparing audio…" : speaking ? "■ Stop" : "▶ Listen"}
        </button>
      )}
    </div>
  );
  const audio = m.input_mode === "voice" ? m.attachments.find((a) => a.content_type.startsWith("audio/")) : undefined;
  const files = m.attachments.filter((a) => a !== audio);

  if (m.role === "owner") {
    return (
      <li className={`group flex flex-col items-end ${highlight ? "nx-highlight" : ""}`} data-testid="message" data-role="owner" id={`message-${m.id}`}>
        <div className="max-w-[min(42rem,88%)] rounded-2xl rounded-br-md bg-nx-violet/20 px-4 py-2.5 ring-1 ring-nx-violet/40">
          {m.input_mode === "voice" && (
            <p className="mb-1 text-[11px] font-medium text-nx-cyan" data-testid="voice-badge">
              🎙️ Voice message · transcript
            </p>
          )}
          {m.content && <Markdown text={m.content} />}
          {audio && <audio controls preload="none" src={`${attachmentUrl(audio.id)}?play=1`} className="mt-2 h-8 w-64 max-w-full" aria-label="Play the recording" />}
          {files.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Attachments">
              {files.map((a) => (
                <li key={a.id}>
                  <a href={attachmentUrl(a.id)} download={a.filename} className="inline-flex items-center gap-1.5 rounded-lg bg-black/25 px-2 py-1 text-xs text-nx-text ring-1 ring-white/10 hover:ring-nx-cyan/50">
                    <span aria-hidden>📎</span>
                    {a.filename}
                    <span className="text-nx-faint">
                      {formatBytes(a.size)} · {a.readable ? (a.truncated ? "read (first part)" : "read by the model") : "not readable as text"}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
        <span className="mt-1 text-[10px] text-nx-faint">You · {time(m.created_at)}</span>
        {actions}
      </li>
    );
  }

  const streaming = m.status === "streaming";
  // Opened mid-reply (no progress event seen yet): text already arriving means "writing".
  state = state ?? (streaming && m.content ? "writing" : null);
  return (
    <li className={`group flex gap-3 ${highlight ? "nx-highlight" : ""}`} data-testid="message" data-role="agent" data-status={m.status} id={`message-${m.id}`}>
      <AgentAvatar m={m} />
      <div className="min-w-0 max-w-[min(46rem,88%)]">
        <p className="text-xs">
          <span className="font-semibold text-nx-text">{m.author_name ?? "Unknown"}</span>
          <span className="text-nx-faint">
            {" "}
            · {m.author_role}
            {departmentName ? ` · ${departmentName}` : ""} · {time(m.created_at)}
          </span>
        </p>
        <div className="mt-1 rounded-2xl rounded-tl-md bg-white/[0.04] px-4 py-2.5 ring-1 ring-nx-line">
          {m.content && <Markdown text={m.content} streaming={streaming && state === "writing"} />}
          {streaming && state !== "writing" && (
            <p className="flex items-center gap-2 text-sm text-nx-muted" role="status">
              <span className="nx-pulse size-2 rounded-full bg-nx-cyan" />
              {state ? REPLY_STATE_TEXT[state as Exclude<ReplyState, "done">] : "Writing…"}
            </p>
          )}
          {m.status === "stopped" && <p className="mt-1 text-xs text-nx-warn">Stopped by you{m.content ? " — the reply above is incomplete." : " before any text arrived."}</p>}
          {m.status === "error" && (
            <div role="alert" className="text-sm text-nx-error">
              <p>
                <span className="font-semibold">No reply.</span> {m.error}
              </p>
              {isLast && (
                <button type="button" onClick={onRetry} disabled={busy} className="mt-2 rounded-lg px-2.5 py-1 text-xs text-nx-text ring-1 ring-nx-line-strong hover:bg-white/5 disabled:opacity-50">
                  Try again
                </button>
              )}
            </div>
          )}
        </div>
        <MessageMeta m={m} />
        {actions}
      </div>
    </li>
  );
}

export function ConversationView({
  conversation,
  target,
  onCreated,
  onDeleted,
  onBack,
  highlightMessage,
}: {
  conversation: Conversation | null;
  target: Addressee;
  onCreated: (id: string) => void;
  onDeleted: () => void;
  onBack: () => void;
  highlightMessage: number | null;
}) {
  const employees = useEmployeeStore((s) => s.employees);
  const departments = useDepartmentStore((s) => s.departments);
  const id = conversation?.id ?? null;
  const messages = useChatStore((s) => (id ? s.messages[id] : undefined));
  const load = useChatStore((s) => (id ? s.messageLoad[id] : "ready"));
  const loadError = useChatStore((s) => (id ? s.messageError[id] : ""));
  const reply = useChatStore((s) => (id ? s.replies[id] : undefined));
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [task, setTask] = useState<TaskSource | null>(null);
  const [renaming, setRenaming] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (id) void useChatStore.getState().loadMessages(id);
  }, [id]);

  const targetName = useTargetName(conversation ?? { kind: target.kind, employee_id: target.employee_id ?? null, department: target.department ?? (employees.find((e) => e.id === target.employee_id)?.department ?? "") });
  const responder = responderFor(conversation ? { kind: conversation.kind, employee_id: conversation.employee_id, department: conversation.department } : target, employees, departments);
  const list = messages ?? NO_MESSAGES;
  const streaming = list.some((m) => m.status === "streaming") || Boolean(reply);
  const submitRef = useRef<() => Promise<void>>(async () => {});
  const voice = useChatVoice({
    conversationId: id,
    messages: list,
    text,
    setText,
    submit: () => void submitRef.current(),
    canSend: !responder.unavailable && !streaming && !sending,
  });
  const ttsReady = useVoiceStore((s) => installed(s.overview, "tts"));

  // Follow new text while the owner is at the bottom; leave them alone if they scrolled up.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [list, reply?.state]);
  useEffect(() => {
    if (!highlightMessage) return;
    document.getElementById(`message-${highlightMessage}`)?.scrollIntoView({ block: "center" });
  }, [highlightMessage, messages]);

  const addFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    const tooBig = picked.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) return setError(`“${tooBig.name}” is larger than ${formatBytes(MAX_FILE_BYTES)}.`);
    const next = [...files, ...picked];
    if (next.length > MAX_FILES) return setError(`Attach at most ${MAX_FILES} files per message.`);
    setError(null);
    setFiles(next);
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (sending || streaming || (!text.trim() && files.length === 0)) return;
    setSending(true);
    setError(null);
    stick.current = true;
    const spoken = voice.voicePayload();
    const all = [...files, ...spoken.files];
    try {
      const store = useChatStore.getState();
      if (id) {
        await store.send({ conversationId: id }, text, all, spoken.inputMode);
      } else {
        const created = await store.send(
          { target: target.kind === "employee" ? { kind: "employee", employee_id: target.employee_id! } : { kind: "department", department: target.department! } },
          text,
          all,
          spoken.inputMode,
        );
        onCreated(created);
      }
      setText("");
      setFiles([]);
      voice.clearDraft();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    submitRef.current = () => submit();
  });

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const act = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const status = responder.employee ? STATUS_META[responder.employee.status] : null;
  const departmentKey = conversation?.department ?? target.department ?? responder.employee?.department ?? "";
  const viaText =
    responder.via === "director" ? `Answered by ${responder.employee?.name}, director` : responder.via === "senior" ? `Answered by ${responder.employee?.name} (most senior available — no active director)` : responder.employee?.role;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="conversation">
      <header className="flex items-center gap-3 border-b border-nx-line px-4 py-3">
        <button type="button" onClick={onBack} className="rounded-lg px-2 py-1 text-sm text-nx-muted ring-1 ring-nx-line-strong lg:hidden" aria-label="Back to conversations">
          ←
        </button>
        {conversation ? (
          <TargetAvatar conversation={conversation} />
        ) : responder.employee && target.kind === "employee" ? (
          <Initials employee={responder.employee} />
        ) : (
          <TargetAvatar conversation={{ kind: "department", employee_id: null, department: departmentKey }} />
        )}
        <div className="min-w-0 flex-1">
          {renaming && conversation ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const title = new FormData(e.currentTarget).get("title")?.toString().trim();
                setRenaming(false);
                if (title && title !== conversation.title) void act(() => useChatStore.getState().rename(conversation.id, title));
              }}
            >
              <input name="title" defaultValue={conversation.title} maxLength={120} autoFocus onBlur={(e) => e.currentTarget.form?.requestSubmit()} aria-label="Conversation title" className="h-8 w-full rounded-lg bg-nx-bg/80 px-2 text-sm text-nx-text ring-1 ring-nx-violet/60 focus:outline-none" />
            </form>
          ) : (
            <h2 className="truncate text-sm font-semibold text-nx-text" data-testid="conversation-title">
              {conversation?.title ?? `New conversation with ${targetName}`}
            </h2>
          )}
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-nx-muted">
            <span className="truncate">
              {targetName}
              {viaText ? ` · ${viaText}` : ""}
            </span>
            {status && responder.employee && (
              <span className="inline-flex items-center gap-1.5" data-testid="responder-status">
                <span className="size-2 rounded-full" style={{ background: status.color, boxShadow: `0 0 8px ${status.color}` }} />
                {status.label}
                {responder.employee.status_detail ? ` — ${responder.employee.status_detail}` : ""}
              </span>
            )}
          </p>
        </div>
        {conversation && (
          <div className="flex shrink-0 gap-1.5">
            <button type="button" onClick={() => setRenaming(true)} className="rounded-lg px-2.5 py-1 text-xs text-nx-muted ring-1 ring-nx-line-strong hover:text-nx-text">
              Rename
            </button>
            <button
              type="button"
              onClick={() => {
                if (!window.confirm(`Delete “${conversation.title}” and its ${conversation.message_count} messages? This can't be undone. Tasks created from it are kept.`)) return;
                void act(async () => {
                  await useChatStore.getState().remove(conversation.id);
                  onDeleted();
                });
              }}
              className="rounded-lg px-2.5 py-1 text-xs text-nx-muted ring-1 ring-nx-line-strong hover:text-nx-error"
            >
              Delete
            </button>
          </div>
        )}
      </header>

      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-5"
        aria-live="polite"
        aria-busy={streaming}
      >
        {load === "loading" && <p className="text-sm text-nx-muted">Loading messages…</p>}
        {load === "error" && (
          <p role="alert" className="text-sm text-nx-error">
            Couldn&apos;t load messages ({loadError}).
          </p>
        )}
        {list.length === 0 && load !== "loading" && load !== "error" && (
          <div className="mx-auto mt-10 max-w-md text-center text-sm text-nx-muted">
            <p>
              Write to <span className="text-nx-text">{targetName}</span>.
              {target.kind === "department" || conversation?.kind === "department"
                ? " The department's director answers, or its most senior available member if there is no active director."
                : ""}
            </p>
            <p className="mt-2 text-xs text-nx-faint">Markdown works. Text files you attach are read by the model; other files are stored but can&apos;t be read.</p>
          </div>
        )}
        <ul className="mx-auto flex max-w-4xl flex-col gap-5">
          {list.map((m, i) => (
            <MessageItem
              key={m.id}
              m={m}
              state={reply && reply.messageId === m.id ? reply.state : null}
              isLast={i === list.length - 1}
              busy={streaming}
              highlight={m.id === highlightMessage}
              speaking={voice.speech.messageId === m.id ? voice.speech.status : null}
              canListen={ttsReady}
              onRetry={() => id && void act(() => useChatStore.getState().retry(id))}
              onTask={(msg) =>
                id &&
                setTask({
                  text: msg.content,
                  department: msg.author_department ?? departmentKey,
                  assigneeId: msg.role === "agent" ? msg.employee_id : conversation?.kind === "employee" ? conversation.employee_id : null,
                  conversationId: id,
                  messageId: msg.id,
                })
              }
            />
          ))}
        </ul>
      </div>

      <form onSubmit={submit} className="border-t border-nx-line p-3">
        {responder.unavailable ? (
          <p className="rounded-xl bg-nx-warn/10 px-4 py-3 text-sm text-nx-warn ring-1 ring-nx-warn/30" role="status">
            {responder.unavailable}
          </p>
        ) : (
          <>
            {voice.sessionBar}
            {voice.draftChip}
            {files.length > 0 && (
              <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Files to send">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.05] px-2 py-1 text-xs text-nx-text ring-1 ring-nx-line-strong">
                    {f.name}
                    <span className="text-nx-faint">
                      {formatBytes(f.size)} · {looksReadable(f) ? "text" : "not readable as text"}
                    </span>
                    <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`} className="text-nx-faint hover:text-nx-error">
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-end gap-2">
              <input ref={fileInput} type="file" multiple hidden onChange={addFiles} data-testid="file-input" />
              <button type="button" onClick={() => fileInput.current?.click()} className="h-10 shrink-0 rounded-lg px-3 text-sm text-nx-muted ring-1 ring-nx-line-strong hover:text-nx-text" aria-label="Attach files">
                📎
              </button>
              {voice.micButton}
              {voice.sessionButton}
              <textarea
                dir="auto"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                rows={Math.min(8, Math.max(1, text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 70)), 0)))}
                maxLength={16000}
                placeholder={responder.employee ? `Message ${target.kind === "department" || conversation?.kind === "department" ? targetName : responder.employee.name.split(" ")[0]}…` : "Message…"}
                aria-label="Message"
                className="max-h-48 min-h-10 flex-1 resize-none rounded-lg bg-nx-bg/80 px-3 py-2 text-sm leading-6 text-nx-text ring-1 ring-nx-line-strong placeholder:text-nx-faint focus:ring-nx-violet/60 focus:outline-none"
              />
              {streaming && id ? (
                <button type="button" onClick={() => void act(() => useChatStore.getState().stop(id))} className="h-10 shrink-0 rounded-lg px-4 text-sm font-semibold text-nx-warn ring-1 ring-nx-warn/50 hover:bg-nx-warn/10">
                  Stop
                </button>
              ) : (
                <button type="submit" disabled={sending || (!text.trim() && files.length === 0)} className="h-10 shrink-0 rounded-lg bg-nx-violet/30 px-4 text-sm font-semibold text-white ring-1 ring-nx-violet/60 hover:bg-nx-violet/40 disabled:opacity-50">
                  {sending ? "Sending…" : "Send"}
                </button>
              )}
            </div>
            <p className="mt-1.5 text-[10px] text-nx-faint">
              Enter to send · Shift+Enter for a new line · 🎙️ voice message · 🎧 voice session · up to {MAX_FILES} files, {formatBytes(MAX_FILE_BYTES)} each ·{" "}
              <Link href="/settings/ai" className="hover:text-nx-muted">
                usage &amp; limits
              </Link>{" "}
              ·{" "}
              <Link href="/settings/voice" className="hover:text-nx-muted">
                voice settings
              </Link>
            </p>
            {voice.messages}
          </>
        )}
        {error && (
          <p role="alert" className="mt-2 text-sm text-nx-error">
            {error}
          </p>
        )}
      </form>

      {task && <TaskDialog source={task} onClose={() => setTask(null)} />}
    </div>
  );
}
