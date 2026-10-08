"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import { AppShell, LoadState } from "@/components/org/AppShell";
import { Badge, ghostBtn, input, labelCls, primaryBtn, Section, SettingsNav, timeAgo } from "@/components/settings/ui";
import {
  ACCOUNT_TEXT,
  createAccount,
  disconnectAccount,
  type EmailAccount,
  type EmailProvider,
  fetchAccounts,
  fetchProviders,
  SECURITY_LABEL,
  type Security,
  startOAuth,
  syncAccount,
  testAccount,
  type TestResult,
  updateAccount,
} from "@/lib/email";
import { liveEvents } from "@/lib/events";

const SECURITIES: Security[] = ["ssl", "starttls", "none"];

function TestSteps({ result }: { result: TestResult }) {
  return (
    <ul className="mt-2 space-y-1 text-xs" aria-label="Connection test result">
      {result.steps.map((s) =>
        s.name === "hint" ? (
          <li key={s.name} className="text-nx-warn">
            Tip: {s.detail}
          </li>
        ) : (
          <li key={s.name} className={s.ok ? "text-nx-ok" : "text-nx-error"}>
            {s.ok ? "✓" : "✕"} <span className="font-semibold">{s.name.toUpperCase()}</span> — {s.detail}
          </li>
        ),
      )}
    </ul>
  );
}

interface FormState {
  provider: string;
  auth_method: "password" | "oauth" | "api_key";
  address: string;
  label: string;
  display_name: string;
  username: string;
  password: string;
  oauth_client_id: string;
  oauth_client_secret: string;
  api_key: string;
  imap_password: string;
  smtp_host: string;
  smtp_port: string;
  smtp_security: Security;
  read_inbox: boolean;
  imap_host: string;
  imap_port: string;
  imap_security: Security;
}

function fromPreset(p: EmailProvider, prev?: Partial<FormState>): FormState {
  return {
    provider: p.key,
    auth_method: p.api ? "api_key" : prev?.auth_method === "oauth" && p.oauth ? "oauth" : "password",
    address: prev?.address ?? "",
    label: prev?.label ?? "",
    display_name: prev?.display_name ?? "",
    username: prev?.username ?? "",
    password: "",
    oauth_client_id: "",
    oauth_client_secret: "",
    api_key: "",
    imap_password: "",
    smtp_host: p.smtp_host,
    smtp_port: String(p.smtp_port),
    smtp_security: p.smtp_security,
    read_inbox: Boolean(p.imap_host) || p.key === "custom",
    // Brevo only sends; reading the inbox is optional and uses the mailbox's own server.
    imap_host: p.imap_host ?? "",
    imap_port: String(p.imap_port ?? 993),
    imap_security: p.imap_security ?? "ssl",
  };
}

function ServerFields({ f, set, kind }: { f: FormState; set: (patch: Partial<FormState>) => void; kind: "smtp" | "imap" }) {
  const host = kind === "smtp" ? f.smtp_host : f.imap_host;
  const port = kind === "smtp" ? f.smtp_port : f.imap_port;
  const security = kind === "smtp" ? f.smtp_security : f.imap_security;
  const name = kind === "smtp" ? "Sending server (SMTP)" : "Inbox server (IMAP)";
  return (
    <fieldset className="grid gap-3 sm:grid-cols-[1fr_7rem_11rem]">
      <legend className="mb-1 text-xs font-semibold text-nx-text">{name}</legend>
      <label className={labelCls}>
        Host
        <input className={input} value={host} onChange={(e) => set({ [`${kind}_host`]: e.target.value } as Partial<FormState>)} required placeholder={kind === "smtp" ? "smtp.example.com" : "imap.example.com"} />
      </label>
      <label className={labelCls}>
        Port
        <input className={input} inputMode="numeric" value={port} onChange={(e) => set({ [`${kind}_port`]: e.target.value.replace(/\D/g, "") } as Partial<FormState>)} required />
      </label>
      <label className={labelCls}>
        Encryption
        <select className={input} value={security} onChange={(e) => set({ [`${kind}_security`]: e.target.value } as Partial<FormState>)}>
          {SECURITIES.map((s) => (
            <option key={s} value={s}>
              {SECURITY_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}

function AddAccount({ providers, redirectUri, onDone }: { providers: EmailProvider[]; redirectUri: string; onDone: (account: EmailAccount, test: TestResult | null) => void }) {
  const [f, setF] = useState<FormState>(() => fromPreset(providers.find((p) => p.key === "brevo") ?? providers[0]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preset = providers.find((p) => p.key === f.provider) ?? providers[0];
  const set = (patch: Partial<FormState>) => setF((prev) => ({ ...prev, ...patch }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const oauth = f.auth_method === "oauth";
      const api = f.auth_method === "api_key";
      const result = await createAccount({
        provider: f.provider,
        auth_method: f.auth_method,
        address: f.address.trim(),
        label: f.label.trim() || null,
        display_name: f.display_name.trim() || null,
        username: f.username.trim() || null,
        password: oauth || api ? null : f.password,
        oauth_client_id: oauth ? f.oauth_client_id.trim() : null,
        oauth_client_secret: oauth ? f.oauth_client_secret.trim() || null : null,
        api_key: api ? f.api_key.trim() : null,
        imap_password: api && f.read_inbox ? f.imap_password : null,
        ...(api ? {} : { smtp_host: f.smtp_host.trim(), smtp_port: Number(f.smtp_port), smtp_security: f.smtp_security }),
        imap_host: f.read_inbox ? f.imap_host.trim() || null : null,
        imap_port: f.read_inbox ? Number(f.imap_port) : null,
        imap_security: f.read_inbox ? f.imap_security : null,
      });
      onDone(result.account, result.test);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" aria-label="Add an email account">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelCls}>
          Provider
          <select className={input} value={f.provider} onChange={(e) => setF((prev) => fromPreset(providers.find((p) => p.key === e.target.value)!, prev))}>
            {providers.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {preset.api ? (
          <label className={labelCls}>
            Brevo API key
            <input className={input} type="password" required value={f.api_key} onChange={(e) => set({ api_key: e.target.value })} autoComplete="new-password" placeholder="xkeysib-…" />
            <span className="mt-1 block text-[11px] text-nx-faint">Stored encrypted on this computer and never shown again.</span>
          </label>
        ) : (
          <label className={labelCls}>
            Sign-in method
            <select className={input} value={f.auth_method} onChange={(e) => set({ auth_method: e.target.value as FormState["auth_method"] })}>
              <option value="password">Password / app password</option>
              {preset.oauth && <option value="oauth">OAuth ({preset.oauth === "google" ? "Google" : "Microsoft"})</option>}
            </select>
          </label>
        )}
      </div>
      <p className="rounded-lg bg-white/[0.03] px-3 py-2 text-xs leading-5 text-nx-muted ring-1 ring-nx-line">{preset.note}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelCls}>
          {preset.api ? "Sender address (verified in Brevo)" : "Email address (the sender)"}
          <input className={input} type="email" required value={f.address} onChange={(e) => set({ address: e.target.value })} placeholder="name@example.com" autoComplete="off" />
        </label>
        <label className={labelCls}>
          Sender name (optional)
          <input className={input} value={f.display_name} onChange={(e) => set({ display_name: e.target.value })} placeholder="Your company" maxLength={120} />
        </label>
        <label className={labelCls}>
          Label in NEXUS (optional)
          <input className={input} value={f.label} onChange={(e) => set({ label: e.target.value })} placeholder="Sales mailbox" maxLength={80} />
        </label>
        {!preset.api && (
          <label className={labelCls}>
            Username (if different from the address)
            <input className={input} value={f.username} onChange={(e) => set({ username: e.target.value })} placeholder={f.address || "same as the address"} autoComplete="off" />
          </label>
        )}
      </div>
      {f.auth_method === "api_key" ? null : f.auth_method === "password" ? (
        <label className={`${labelCls} sm:w-1/2`}>
          Password or app password
          <input className={input} type="password" required value={f.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" />
          <span className="mt-1 block text-[11px] text-nx-faint">Stored encrypted on this computer and never shown again.</span>
        </label>
      ) : (
        <div className="space-y-3 rounded-lg bg-white/[0.02] p-3 ring-1 ring-nx-line">
          <p className="text-xs leading-5 text-nx-muted">
            Use your own OAuth app registration ({preset.oauth === "google" ? "Google Cloud Console → Credentials → OAuth client ID, type “Web application”" : "Azure portal → App registrations"}). Add this redirect URI to it:
          </p>
          <code className="block break-all rounded bg-nx-bg/80 px-2 py-1 font-mono text-[11px] text-nx-cyan">{redirectUri}</code>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={labelCls}>
              Client ID
              <input className={input} required value={f.oauth_client_id} onChange={(e) => set({ oauth_client_id: e.target.value })} autoComplete="off" />
            </label>
            {preset.oauth_needs_secret && (
              <label className={labelCls}>
                Client secret
                <input className={input} type="password" required value={f.oauth_client_secret} onChange={(e) => set({ oauth_client_secret: e.target.value })} autoComplete="new-password" />
              </label>
            )}
          </div>
        </div>
      )}
      {!preset.api && <ServerFields f={f} set={set} kind="smtp" />}
      <label className="flex items-center gap-2 text-xs text-nx-muted">
        <input type="checkbox" checked={f.read_inbox} onChange={(e) => set({ read_inbox: e.target.checked })} />
        {preset.api ? "Also read this mailbox's inbox (IMAP, read-only) to see incoming mail and draft replies" : "Read the inbox too (IMAP, read-only — nothing is marked or deleted)"}
      </label>
      {f.read_inbox && preset.api && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={labelCls}>
            Mailbox provider (fills the server below)
            <select
              className={input}
              defaultValue=""
              onChange={(e) => {
                const p = providers.find((x) => x.key === e.target.value);
                if (p?.imap_host) set({ imap_host: p.imap_host, imap_port: String(p.imap_port ?? 993), imap_security: p.imap_security ?? "ssl" });
              }}
            >
              <option value="">Choose…</option>
              {providers
                .filter((p) => p.imap_host)
                .map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
            </select>
          </label>
          <label className={labelCls}>
            Mailbox password (Gmail, Yahoo, iCloud: an app password)
            <input className={input} type="password" required value={f.imap_password} onChange={(e) => set({ imap_password: e.target.value })} autoComplete="new-password" />
          </label>
        </div>
      )}
      {f.read_inbox && <ServerFields f={f} set={set} kind="imap" />}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={primaryBtn} disabled={busy}>
          {busy ? (f.auth_method === "oauth" ? "Saving…" : "Saving and testing…") : f.auth_method === "oauth" ? "Save, then sign in" : "Save and test connection"}
        </button>
        <p className="text-xs text-nx-faint">{preset.api ? "Testing checks the API key and your sender in Brevo; it sends nothing." : "Testing signs in to the servers; it sends nothing."}</p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-nx-error">
          {error}
        </p>
      )}
    </form>
  );
}

function EditAccount({ account, onDone }: { account: EmailAccount; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState(account.display_name);
  const [label, setLabel] = useState(account.label);
  const [smtpHost, setSmtpHost] = useState(account.smtp_host);
  const [smtpPort, setSmtpPort] = useState(String(account.smtp_port));
  const [imapHost, setImapHost] = useState(account.imap_host ?? "");
  const [imapPort, setImapPort] = useState(String(account.imap_port ?? 993));
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [imapPassword, setImapPassword] = useState("");
  const api = account.auth_method === "api_key";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await updateAccount(account.id, {
        label,
        display_name: displayName,
        ...(api ? { api_key: apiKey || null, imap_password: imapPassword || null } : { smtp_host: smtpHost, smtp_port: Number(smtpPort) }),
        imap_host: imapHost || null,
        imap_port: imapHost ? Number(imapPort) : null,
        imap_security: imapHost ? (account.imap_security ?? "ssl") : null,
        clear_imap: !imapHost && Boolean(account.imap_host),
        password: password || null,
        oauth_client_id: clientId || null,
        oauth_client_secret: clientSecret || null,
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mt-3 grid gap-3 rounded-lg bg-white/[0.02] p-3 ring-1 ring-nx-line sm:grid-cols-2" aria-label={`Edit ${account.address}`}>
      <label className={labelCls}>
        Label
        <input className={input} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
      </label>
      <label className={labelCls}>
        Sender name
        <input className={input} value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={120} />
      </label>
      {api ? (
        <label className={labelCls}>
          New Brevo API key (leave empty to keep the saved one)
          <input className={input} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="new-password" />
        </label>
      ) : (
        <label className={labelCls}>
          SMTP host · port
          <span className="flex gap-2">
            <input className={input} value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
            <input className={`${input} w-24`} value={smtpPort} onChange={(e) => setSmtpPort(e.target.value.replace(/\D/g, ""))} aria-label="SMTP port" />
          </span>
        </label>
      )}
      <label className={labelCls}>
        IMAP host · port (empty: don&apos;t read the inbox)
        <span className="flex gap-2">
          <input className={input} value={imapHost} onChange={(e) => setImapHost(e.target.value)} />
          <input className={`${input} w-24`} value={imapPort} onChange={(e) => setImapPort(e.target.value.replace(/\D/g, ""))} aria-label="IMAP port" />
        </span>
      </label>
      {api ? (
        <label className={labelCls}>
          New mailbox password for the inbox (optional)
          <input className={input} type="password" value={imapPassword} onChange={(e) => setImapPassword(e.target.value)} autoComplete="new-password" />
        </label>
      ) : account.auth_method === "password" ? (
        <label className={labelCls}>
          New password (leave empty to keep the saved one)
          <input className={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </label>
      ) : (
        <>
          <label className={labelCls}>
            New OAuth client ID (optional)
            <input className={input} value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
          </label>
          <label className={labelCls}>
            New client secret (optional)
            <input className={input} type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="new-password" />
          </label>
        </>
      )}
      <div className="flex items-center gap-2 sm:col-span-2">
        <button type="submit" className={primaryBtn} disabled={busy}>
          Save changes
        </button>
        <button type="button" className={ghostBtn} onClick={onDone}>
          Cancel
        </button>
        {error && (
          <p role="alert" className="text-xs text-nx-error">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}

function AccountCard({ account, test, onChanged }: { account: EmailAccount; test?: TestResult; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tested, setResult] = useState<TestResult | null>(null);
  // A test run here wins over the one from creating the account.
  const result = tested ?? test ?? null;
  const [editing, setEditing] = useState(false);
  const [text, tone] = ACCOUNT_TEXT[account.status];

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    setNote(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const signIn = () =>
    act("oauth", async () => {
      const { url } = await startOAuth(account.id);
      window.location.assign(url);
    });

  return (
    <li className="rounded-xl bg-white/[0.02] p-4 ring-1 ring-nx-line" data-testid="email-account" data-account={account.address}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-nx-text">
            {account.label}
            {account.is_default && <span className="ml-2 text-[11px] font-normal text-nx-cyan">default sender</span>}
          </p>
          <p className="mt-0.5 truncate text-xs text-nx-faint">
            {account.display_name ? `${account.display_name} <${account.address}>` : account.address} · {account.provider_label} · {account.auth_method === "oauth" ? "OAuth" : account.auth_method === "api_key" ? "API key" : "password"}
          </p>
          <p className="mt-0.5 text-[11px] text-nx-faint">
            {account.auth_method === "api_key" ? "Sends through the Brevo API" : `SMTP ${account.smtp_host}:${account.smtp_port} (${SECURITY_LABEL[account.smtp_security]})`} ·{" "}
            {account.imap_host ? `IMAP ${account.imap_host}:${account.imap_port}` : "no inbox reading"}
          </p>
        </div>
        <Badge tone={tone}>{text}</Badge>
      </div>
      {account.status_detail && account.status !== "connected" && <p className="mt-2 text-xs text-nx-muted">{account.status_detail}</p>}
      <p className="mt-2 text-[11px] text-nx-faint">
        Last test: {account.last_test_at ? `${timeAgo(account.last_test_at)} (${account.last_test_ok ? "passed" : "failed"})` : "never"} · Inbox synced: {timeAgo(account.last_sync_at)}
      </p>
      {result && <TestSteps result={result} />}
      {note && (
        <p role="status" className="mt-2 text-xs text-nx-ok">
          {note}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-nx-error">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {account.auth_method === "oauth" && account.status !== "connected" && account.oauth_client_saved && (
          <button type="button" className={primaryBtn} disabled={busy !== null} onClick={() => void signIn()}>
            Sign in with {account.provider === "outlook" ? "Microsoft" : "Google"}
          </button>
        )}
        {account.status !== "disconnected" && (
          <button type="button" className={ghostBtn} disabled={busy !== null || !account.has_secret} onClick={() => void act("test", async () => setResult(await testAccount(account.id)))}>
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
        )}
        {account.imap_host && account.status === "connected" && (
          <button
            type="button"
            className={ghostBtn}
            disabled={busy !== null}
            onClick={() =>
              void act("sync", async () => {
                const r = await syncAccount(account.id);
                setNote(`${r.new} new message${r.new === 1 ? "" : "s"} in the inbox.`);
              })
            }
          >
            {busy === "sync" ? "Syncing…" : "Sync inbox"}
          </button>
        )}
        {!account.is_default && account.status === "connected" && (
          <button type="button" className={ghostBtn} disabled={busy !== null} onClick={() => void act("default", async () => void (await updateAccount(account.id, { make_default: true })))}>
            Make default sender
          </button>
        )}
        <button type="button" className={ghostBtn} onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
          {account.status === "disconnected" ? "Reconnect…" : "Edit"}
        </button>
        {account.status !== "disconnected" ? (
          <button
            type="button"
            className={`${ghostBtn} text-nx-error`}
            disabled={busy !== null}
            onClick={() =>
              window.confirm(`Disconnect ${account.address}? The saved password or sign-in is deleted${account.auth_method === "oauth" ? " (and revoked with the provider where possible)" : ""}. Drafts waiting for approval are withdrawn; sent and received mail stays in NEXUS.`) &&
              void act("disconnect", () => disconnectAccount(account.id))
            }
          >
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            className={`${ghostBtn} text-nx-error`}
            disabled={busy !== null}
            onClick={() => window.confirm(`Remove ${account.address} and delete all of its stored email from NEXUS? This can't be undone.`) && void act("purge", () => disconnectAccount(account.id, true))}
          >
            Remove with history
          </button>
        )}
      </div>
      {editing && (
        <EditAccount
          account={account}
          onDone={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
    </li>
  );
}

export function EmailSettingsPage() {
  const [providers, setProviders] = useState<EmailProvider[] | null>(null);
  const [data, setData] = useState<{ accounts: EmailAccount[]; secret_key_present: boolean; oauth_redirect_uri: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([fetchProviders(), fetchAccounts()]);
      setProviders(p);
      setData(a);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => {
      void load();
      // Returning from an OAuth sign-in.
      const params = new URLSearchParams(window.location.search);
      const oauth = params.get("oauth");
      if (oauth) {
        setBanner(oauth === "ok" ? { ok: true, text: "Signed in. The connection was tested — see the account below." } : { ok: false, text: params.get("message") ?? "The sign-in failed." });
        window.history.replaceState(null, "", "/settings/email");
      }
    }, 0);
    const release = liveEvents.retain();
    const off = [liveEvents.on("email.account", () => void load()), liveEvents.on("email.removed", () => void load()), liveEvents.onStatus((_s, again) => again && void load())];
    return () => {
      clearTimeout(first);
      off.forEach((f) => f());
      release();
    };
  }, [load]);

  const accounts = data?.accounts ?? [];
  return (
    <AppShell
      title="Email accounts"
      subtitle={
        <>
          Choose how your company sends email — Brevo or a mailbox you connect directly. Employees only write drafts: every email waits for your approval in the{" "}
          <Link href="/email" className="text-nx-indigo hover:text-nx-cyan">
            approval queue
          </Link>{" "}
          and is sent only after you approve it.
        </>
      }
      actions={<SettingsNav current="/settings/email" />}
    >
      {banner && (
        <p role={banner.ok ? "status" : "alert"} className={`glass-solid p-4 text-sm ${banner.ok ? "text-nx-ok" : "text-nx-error"}`}>
          {banner.text}
        </p>
      )}
      <LoadState load={error ? "error" : data && providers ? "ready" : "loading"} error={error} />
      {data && providers && (
        <>
          {!data.secret_key_present && (
            <p role="alert" className="glass-solid p-4 text-sm text-nx-warn">
              NEXUS_SECRET_KEY is not set, so passwords can&apos;t be stored safely. Run <code className="font-mono">make setup</code> and restart the backend.
            </p>
          )}
          <Section id="email-accounts" title="Connected accounts" aside={accounts.length ? `${accounts.length} account${accounts.length === 1 ? "" : "s"}` : undefined}>
            {accounts.length === 0 ? (
              <p className="text-sm text-nx-muted">No email account yet. NEXUS has no built-in sender address — add the account you want the company to use.</p>
            ) : (
              <ul className="space-y-3">
                {accounts.map((a) => (
                  <AccountCard key={a.id} account={a} test={tests[a.id]} onChanged={() => void load()} />
                ))}
              </ul>
            )}
            <div className="mt-4">
              {adding ? (
                <div className="space-y-3 rounded-xl bg-white/[0.02] p-4 ring-1 ring-nx-line">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-nx-text">Add an account</h3>
                    <button type="button" className="text-xs text-nx-muted hover:text-nx-text" onClick={() => setAdding(false)}>
                      Cancel
                    </button>
                  </div>
                  <AddAccount
                    providers={providers}
                    redirectUri={data.oauth_redirect_uri}
                    onDone={(account, test) => {
                      setAdding(false);
                      if (test) setTests((t) => ({ ...t, [account.id]: test }));
                      void load();
                    }}
                  />
                </div>
              ) : (
                <button type="button" className={primaryBtn} onClick={() => setAdding(true)} disabled={!data.secret_key_present}>
                  Add an email account
                </button>
              )}
            </div>
          </Section>
          <Section id="email-safety" title="How sending is kept safe">
            <ul className="list-disc space-y-1.5 pl-5 text-xs leading-5 text-nx-muted">
              <li>Nothing is sent automatically. Each email is sent only after you approve that exact text; editing a draft withdraws the approval.</li>
              <li>Recipients are set by you (or are the sender of the email being answered) — never by an AI model.</li>
              <li>A send that fails before the server accepted it is retried at most twice. If the connection breaks mid-send, the email is marked “uncertain” and is never resent without your confirmation.</li>
              <li>Received email is untrusted: it is shown as plain text, and employees are told not to follow instructions in it.</li>
              <li>Passwords, API keys and OAuth tokens are encrypted with NEXUS_SECRET_KEY, never shown again, and deleted when you disconnect.</li>
            </ul>
          </Section>
        </>
      )}
    </AppShell>
  );
}
