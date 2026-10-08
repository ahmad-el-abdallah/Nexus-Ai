"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { AppShell, LoadState } from "@/components/org/AppShell";
import { Badge, ghostBtn, input, labelCls, primaryBtn, timeAgo } from "@/components/settings/ui";
import {
  approveEmail,
  createDraft,
  deleteDraft,
  editDraft,
  type EmailAccount,
  type EmailLogEntry,
  type EmailMessage,
  fetchAccounts,
  fetchCounts,
  fetchLog,
  fetchMessages,
  type Folder,
  FOLDERS,
  generateDraft,
  parseAddresses,
  redraftEmail,
  rejectEmail,
  resendEmail,
  retryEmail,
  sender,
  STATUS_TEXT,
  STATUS_TONE,
  verifyEmail,
} from "@/lib/email";
import { liveEvents } from "@/lib/events";
import { useEmployeeStore } from "@/world/state/employeeStore";

type Tab = Folder | "log";

const textarea =
  "mt-1 w-full resize-y rounded-lg bg-nx-bg/80 px-3 py-2 text-sm leading-6 text-nx-text ring-1 ring-nx-line-strong placeholder:text-nx-faint focus:ring-nx-violet/60 focus:outline-none";

function useAction(onDone?: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
      onDone?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, run, setError };
}

// ------------------------------------------------------------------ compose

function Composer({ accounts, reply, onDone, onCancel }: { accounts: EmailAccount[]; reply?: EmailMessage; onDone: () => void; onCancel?: () => void }) {
  const employees = useEmployeeStore((s) => s.employees).filter((e) => e.status !== "suspended");
  const usable = accounts.filter((a) => a.status === "connected");
  const fallback = usable.find((a) => a.is_default) ?? usable[0];
  const [accountId, setAccountId] = useState(reply?.account_id ?? fallback?.id ?? "");
  const [to, setTo] = useState(reply ? reply.from_address : "");
  const [cc, setCc] = useState("");
  const [mode, setMode] = useState<"ai" | "manual">("ai");
  const [instructions, setInstructions] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [subject, setSubject] = useState(reply ? (/^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`) : "");
  const [body, setBody] = useState("");
  const { busy, error, run } = useAction(onDone);

  if (!usable.length) {
    return (
      <p className="text-sm text-nx-muted">
        No connected account. Connect one in{" "}
        <Link href="/settings/email" className="text-nx-indigo hover:text-nx-cyan">
          Settings → Email accounts
        </Link>
        .
      </p>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const common = { account_id: accountId, to: parseAddresses(to), cc: parseAddresses(cc), reply_to_id: reply?.id ?? null };
    void run("save", () =>
      mode === "ai" ? generateDraft({ ...common, instructions, employee_id: employeeId || null }) : createDraft({ ...common, subject, body }),
    );
  };

  return (
    <form onSubmit={submit} className="space-y-3" aria-label={reply ? "Reply" : "New email"}>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className={labelCls}>
          From
          <select className={input} value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={Boolean(reply)}>
            {usable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.address}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          To
          <input className={input} value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com, …" required={!reply} />
        </label>
        <label className={labelCls}>
          Cc (optional)
          <input className={input} value={cc} onChange={(e) => setCc(e.target.value)} />
        </label>
      </div>
      <div className="flex gap-1 text-xs" role="radiogroup" aria-label="Who writes it">
        {(
          [
            ["ai", "An employee drafts it"],
            ["manual", "I'll write it"],
          ] as const
        ).map(([key, label]) => (
          <button key={key} type="button" role="radio" aria-checked={mode === key} onClick={() => setMode(key)} className={`rounded-lg px-3 py-1.5 ${mode === key ? "bg-white/10 text-white" : "text-nx-muted ring-1 ring-nx-line-strong hover:text-nx-text"}`}>
            {label}
          </button>
        ))}
      </div>
      {mode === "ai" ? (
        <div className="grid gap-3 sm:grid-cols-[1fr_16rem]">
          <label className={labelCls}>
            What should the email say?
            <textarea dir="auto" className={textarea} rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={4000} placeholder={reply ? "Thank them, answer their question about…, offer a call next week." : "Invite them to a 20-minute demo next week; keep it short and friendly."} required />
          </label>
          <label className={labelCls}>
            Written by
            <select className={input} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">Customer Support (default)</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} — {e.role}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] text-nx-faint">Uses one AI request. You review the draft before anything is sent.</span>
          </label>
        </div>
      ) : (
        <>
          <label className={labelCls}>
            Subject
            <input className={input} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} />
          </label>
          <label className={labelCls}>
            Message
            <textarea dir="auto" className={textarea} rows={6} value={body} onChange={(e) => setBody(e.target.value)} maxLength={20000} required />
          </label>
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={primaryBtn} disabled={busy !== null}>
          {busy ? "Saving…" : mode === "ai" ? "Ask for a draft" : "Add to approval queue"}
        </button>
        {onCancel && (
          <button type="button" className={ghostBtn} onClick={onCancel}>
            Cancel
          </button>
        )}
        <p className="text-xs text-nx-faint">Drafts go to the approval queue. Nothing is sent until you approve it.</p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-nx-error">
          {error}
        </p>
      )}
    </form>
  );
}

// ------------------------------------------------------------------ message

function EditForm({ m, onDone }: { m: EmailMessage; onDone: () => void }) {
  const [to, setTo] = useState(m.to.join(", "));
  const [cc, setCc] = useState(m.cc.join(", "));
  const [subject, setSubject] = useState(m.subject);
  const [body, setBody] = useState(m.body);
  const { busy, error, run } = useAction(onDone);
  return (
    <form
      className="mt-3 space-y-3"
      aria-label="Edit draft"
      onSubmit={(e) => {
        e.preventDefault();
        void run("save", () => editDraft(m.id, { to: parseAddresses(to), cc: parseAddresses(cc), subject, body }));
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelCls}>
          To
          <input className={input} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className={labelCls}>
          Cc
          <input className={input} value={cc} onChange={(e) => setCc(e.target.value)} />
        </label>
      </div>
      <label className={labelCls}>
        Subject
        <input className={input} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} />
      </label>
      <label className={labelCls}>
        Message
        <textarea dir="auto" className={textarea} rows={8} value={body} onChange={(e) => setBody(e.target.value)} maxLength={20000} />
      </label>
      <div className="flex items-center gap-2">
        <button type="submit" className={primaryBtn} disabled={busy !== null}>
          Save draft
        </button>
        <button type="button" className={ghostBtn} onClick={onDone}>
          Cancel
        </button>
        <span className="text-xs text-nx-faint">Saving returns it to the approval queue.</span>
      </div>
      {error && (
        <p role="alert" className="text-xs text-nx-error">
          {error}
        </p>
      )}
    </form>
  );
}

function MessageCard({ m, accounts, onChanged }: { m: EmailMessage; accounts: EmailAccount[]; onChanged: () => void }) {
  const [open, setOpen] = useState(m.status === "pending_approval" || m.status === "uncertain");
  const [editing, setEditing] = useState(false);
  const [replying, setReplying] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const { busy, error, run } = useAction(onChanged);
  const inbound = m.direction === "inbound";
  const when = inbound ? m.received_at : (m.sent_at ?? m.updated_at);
  const recipients = [...m.to, ...m.cc].join(", ");
  const disabled = busy !== null;

  return (
    <li className="glass-solid p-4" data-testid="email-message" data-status={m.status}>
      <button type="button" className="flex w-full flex-wrap items-start justify-between gap-2 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-nx-text">{m.subject || "(no subject)"}</p>
          <p className="mt-0.5 truncate text-xs text-nx-faint">
            {inbound ? `From ${sender(m)}` : `To ${recipients}`} · {inbound ? `to ${m.account_address}` : `from ${m.account_address}`}
            {when ? ` · ${timeAgo(when)}` : ""}
            {m.drafted_by_name && !inbound ? ` · drafted by ${m.drafted_by_name}` : ""}
          </p>
        </div>
        <Badge tone={STATUS_TONE[m.status]}>{STATUS_TEXT[m.status]}</Badge>
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          {inbound && (
            <p className="rounded-lg bg-nx-warn/10 px-3 py-2 text-xs text-nx-warn ring-1 ring-nx-warn/30" role="note">
              External email — untrusted. Shown as plain text; links and attachments are not opened, and employees are told not to follow instructions in it.
            </p>
          )}
          {m.status === "uncertain" && (
            <p className="rounded-lg bg-nx-warn/10 px-3 py-2 text-xs leading-5 text-nx-warn ring-1 ring-nx-warn/30" role="note">
              The connection broke while this email was being sent, so it may already have been delivered. NEXUS will not resend it on its own. Check the Sent folder first; send again only if you accept a possible duplicate.
            </p>
          )}
          {m.last_error && m.status !== "uncertain" && <p className="text-xs text-nx-error">{m.last_error}</p>}
          {m.rejected_reason && <p className="text-xs text-nx-muted">Rejected: {m.rejected_reason}</p>}
          {m.instructions && !inbound && (
            <p className="text-xs text-nx-faint">
              <span className="font-semibold text-nx-muted">Your instructions:</span> {m.instructions}
            </p>
          )}
          {m.status === "drafting" ? (
            <p className="text-sm text-nx-muted" role="status">
              {m.drafted_by_name ?? "An employee"} is writing the draft… (you can watch it on their desk monitor in the office)
            </p>
          ) : editing ? (
            <EditForm
              m={m}
              onDone={() => {
                setEditing(false);
                onChanged();
              }}
            />
          ) : (
            <pre dir="auto" className="max-h-96 overflow-auto rounded-lg bg-nx-bg/70 p-3 font-sans text-sm leading-6 whitespace-pre-wrap text-nx-text ring-1 ring-nx-line">
              {m.body || "(empty)"}
            </pre>
          )}
          {m.attachments.length > 0 && <p className="text-xs text-nx-faint">Attachments (not opened): {m.attachments.join(", ")}</p>}
          <p className="text-[11px] text-nx-faint">
            {!inbound && `Attempts: ${m.send_attempts}`}
            {m.server_response && ` · Server: ${m.server_response}`}
            {m.model && ` · Model: ${m.model}`}
            {" · "}
            <span className="font-mono break-all">{m.message_id_header}</span>
          </p>
          {note && (
            <p role="status" className="text-xs text-nx-muted">
              {note}
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-nx-error">
              {error}
            </p>
          )}
          {!editing && (
            <div className="flex flex-wrap gap-2">
              {m.status === "pending_approval" && (
                <button type="button" className={primaryBtn} disabled={disabled} onClick={() => window.confirm(`Send “${m.subject || "(no subject)"}” from ${m.account_address} to ${recipients}?`) && void run("approve", () => approveEmail(m.id))}>
                  {busy === "approve" ? "Approving…" : "Approve and send"}
                </button>
              )}
              {m.status === "failed" && (
                <button type="button" className={primaryBtn} disabled={disabled} onClick={() => void run("retry", () => retryEmail(m.id))}>
                  Try sending again
                </button>
              )}
              {m.status === "draft_failed" && m.instructions && (
                <button type="button" className={primaryBtn} disabled={disabled} onClick={() => void run("redraft", () => redraftEmail(m.id))}>
                  Write the draft again
                </button>
              )}
              {m.status === "uncertain" && (
                <>
                  <button
                    type="button"
                    className={primaryBtn}
                    disabled={disabled}
                    onClick={() =>
                      void run("verify", async () => {
                        const r = await verifyEmail(m.id);
                        setNote(r.found ? "Found in the Sent folder — it was sent." : "Not found in the Sent folder. Some providers don't keep copies of mail sent this way, so this isn't proof it wasn't delivered.");
                      })
                    }
                  >
                    {busy === "verify" ? "Checking…" : "Check the Sent folder"}
                  </button>
                  <button type="button" className={ghostBtn} disabled={disabled} onClick={() => window.confirm("This email may already have been delivered. Send it again anyway (the recipient might get it twice)?") && void run("resend", () => resendEmail(m.id))}>
                    Send again anyway
                  </button>
                </>
              )}
              {["pending_approval", "draft_failed", "failed"].includes(m.status) && (
                <button type="button" className={ghostBtn} disabled={disabled} onClick={() => setEditing(true)}>
                  Edit
                </button>
              )}
              {["pending_approval", "draft_failed", "failed"].includes(m.status) && (
                <button
                  type="button"
                  className={ghostBtn}
                  disabled={disabled}
                  onClick={() => {
                    const reason = window.prompt("Reject this draft? Optional reason:", "");
                    if (reason !== null) void run("reject", () => rejectEmail(m.id, reason));
                  }}
                >
                  Reject
                </button>
              )}
              {["pending_approval", "draft_failed", "failed", "rejected"].includes(m.status) && (
                <button type="button" className={`${ghostBtn} text-nx-error`} disabled={disabled} onClick={() => window.confirm("Delete this draft?") && void run("delete", () => deleteDraft(m.id))}>
                  Delete
                </button>
              )}
              {inbound && m.account_id && !replying && (
                <button type="button" className={primaryBtn} onClick={() => setReplying(true)}>
                  Draft a reply
                </button>
              )}
            </div>
          )}
          {replying && (
            <div className="rounded-xl bg-white/[0.02] p-4 ring-1 ring-nx-line">
              <Composer
                accounts={accounts}
                reply={m}
                onCancel={() => setReplying(false)}
                onDone={() => {
                  setReplying(false);
                  setNote("Reply draft added to the approval queue.");
                }}
              />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// --------------------------------------------------------------------- page

function LogList({ entries }: { entries: EmailLogEntry[] }) {
  if (!entries.length) return <p className="text-sm text-nx-muted">Nothing logged yet.</p>;
  const tone = { info: "text-nx-muted", warn: "text-nx-warn", error: "text-nx-error" } as const;
  return (
    <ol className="glass-solid divide-y divide-nx-line" aria-label="Email log">
      {entries.map((e) => (
        <li key={e.id} className="flex gap-3 px-4 py-2.5 text-xs" data-level={e.level}>
          <span className="w-24 shrink-0 text-nx-faint">{timeAgo(e.created_at)}</span>
          <span className="w-24 shrink-0 font-mono text-[11px] text-nx-faint">{e.kind}</span>
          <span className={tone[e.level]}>{e.text}</span>
        </li>
      ))}
    </ol>
  );
}

export function EmailPage() {
  const [tab, setTab] = useState<Tab>("approval");
  const [accounts, setAccounts] = useState<EmailAccount[] | null>(null);
  const [messages, setMessages] = useState<EmailMessage[] | null>(null);
  const [log, setLog] = useState<EmailLogEntry[] | null>(null);
  const [counts, setCounts] = useState<Partial<Record<Folder, number>>>({});
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const tabRef = useRef(tab);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const current = tabRef.current;
    try {
      const [a, c] = await Promise.all([fetchAccounts(), fetchCounts()]);
      setAccounts(a.accounts);
      setCounts(c);
      if (current === "log") setLog(await fetchLog());
      else {
        const list = await fetchMessages(current);
        if (tabRef.current === current) setMessages(list);
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  // Live events arrive in bursts while sending; reload at most every 300 ms.
  const soon = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void load();
    }, 300);
  }, [load]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const release = liveEvents.retain();
    const off = [
      ...(["email.message", "email.deleted", "email.log", "email.inbox", "email.account", "email.removed"] as const).map((t) => liveEvents.on(t, soon)),
      liveEvents.onStatus((_s, again) => again && void load()),
    ];
    return () => {
      clearTimeout(first);
      if (timer.current) clearTimeout(timer.current);
      off.forEach((f) => f());
      release();
    };
  }, [load, soon]);

  const select = (next: Tab) => {
    tabRef.current = next;
    setTab(next);
    setMessages(null);
    void load();
  };

  const connected = accounts?.filter((a) => a.status === "connected") ?? [];
  const hint = FOLDERS.find((f) => f.key === tab)?.hint ?? "Everything that happened: connections, tests, syncs, drafts, approvals, sends and failures.";

  return (
    <AppShell
      title="Email"
      subtitle="Employees draft; you approve. Every outgoing email waits here until you approve that exact message."
      actions={
        <div className="flex items-center gap-2">
          <Link href="/settings/email" className={ghostBtn}>
            Accounts
          </Link>
          <button type="button" className={primaryBtn} onClick={() => setComposing((v) => !v)} disabled={!connected.length} aria-expanded={composing}>
            New email
          </button>
        </div>
      }
    >
      <LoadState load={error ? "error" : accounts ? "ready" : "loading"} error={error} />
      {accounts && accounts.length === 0 && (
        <p className="glass-solid p-5 text-sm text-nx-muted">
          No email account is connected. NEXUS has no built-in sender —{" "}
          <Link href="/settings/email" className="text-nx-indigo hover:text-nx-cyan">
            connect your company&apos;s account
          </Link>{" "}
          to draft, approve and send email.
        </p>
      )}
      {accounts && accounts.length > 0 && !connected.length && (
        <p className="glass-solid p-4 text-sm text-nx-warn" role="alert">
          No account is connected right now ({accounts.map((a) => `${a.address}: ${a.status.replace("_", " ")}`).join("; ")}).{" "}
          <Link href="/settings/email" className="underline">
            Fix it in Settings
          </Link>
          .
        </p>
      )}
      {composing && accounts && (
        <section className="glass-solid p-5" aria-label="New email">
          <Composer
            accounts={accounts}
            onCancel={() => setComposing(false)}
            onDone={() => {
              setComposing(false);
              select("approval");
            }}
          />
        </section>
      )}
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Email folders">
        {[...FOLDERS, { key: "log" as const, label: "Log", hint: "" }].map((f) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={tab === f.key}
            onClick={() => select(f.key)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ${tab === f.key ? "bg-white/10 text-white" : "text-nx-muted ring-1 ring-nx-line-strong hover:text-nx-text"}`}
          >
            {f.label}
            {f.key !== "log" && counts[f.key] ? <span className="ml-1.5 rounded-full bg-white/10 px-1.5 text-[10px]">{counts[f.key]}</span> : null}
          </button>
        ))}
      </div>
      <p className="-mt-3 text-xs text-nx-faint">{hint}</p>
      {tab === "log" ? (
        log ? <LogList entries={log} /> : <p className="text-sm text-nx-muted">Loading…</p>
      ) : messages === null ? (
        <p className="text-sm text-nx-muted">Loading…</p>
      ) : messages.length === 0 ? (
        <p className="glass-solid p-5 text-sm text-nx-muted">
          {tab === "approval" ? "No drafts waiting for approval." : tab === "inbox" ? "No received mail yet. Sync the inbox from Settings → Email accounts." : "Nothing here yet."}
        </p>
      ) : (
        <ul className="space-y-3">
          {messages.map((m) => (
            <MessageCard key={`${m.id}:${m.status}`} m={m} accounts={accounts ?? []} onChanged={() => void load()} />
          ))}
        </ul>
      )}
    </AppShell>
  );
}
