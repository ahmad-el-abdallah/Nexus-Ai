"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AppShell } from "@/components/org/AppShell";
import {
  type AIModel,
  type AISettings,
  aiErrorMessage,
  getAIModels,
  getAISettings,
  getAIUsage,
  patchAISettings,
  refreshAIModels,
  removeAIKey,
  saveAIKey,
  testAIConnection,
  type TestResult,
  type UsageSummary,
  verifyAIModel,
} from "@/lib/ai";

import { Playground } from "./Playground";
import { Badge, ghostBtn, input, labelCls, primaryBtn, Section, SettingsNav, timeAgo } from "./ui";
import { UsageDashboard } from "./UsageDashboard";

function modelBadge(m: AIModel) {
  if (!m.listed) return <Badge tone="neutral">No longer listed</Badge>;
  if (m.verified_at) return <Badge tone="ok">Verified{m.last_latency_ms ? ` · ${(m.last_latency_ms / 1000).toFixed(1)}s` : ""}</Badge>;
  if (m.last_error && m.last_error.includes("isn't available")) return <Badge tone="error">Not available to this key</Badge>;
  if (m.last_error) return <Badge tone="warn">Last check failed</Badge>;
  return <Badge tone="neutral">Not tested</Badge>;
}

export function AISettingsPage() {
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [models, setModels] = useState<AIModel[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [s, m, u] = await Promise.all([getAISettings(), getAIModels(), getAIUsage()]);
      setSettings(s);
      setModels(m);
      setUsage(u);
      setLoadError(null);
    } catch (error) {
      setLoadError(aiErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () => getAIUsage().then((u) => alive && setUsage(u), () => undefined);
    const first = window.setTimeout(() => void reload(), 0);
    const t = window.setInterval(tick, 10_000);
    return () => {
      alive = false;
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [reload]);

  return (
    <AppShell
      title="Settings"
      subtitle={
        <>
          AI providers → <strong className="text-nx-text">NVIDIA</strong>. All model calls go through the gateway with budgets, limits and retries — never
          to any paid fallback.
        </>
      }
      actions={<SettingsNav current="/settings/ai" />}
    >
      {loadError && (
        <p role="alert" className="glass-solid p-4 text-sm text-nx-error">
          Couldn&apos;t load AI settings: {loadError}
        </p>
      )}
      {settings && (
        <>
          <StatusStrip settings={settings} onChange={setSettings} />
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <KeyCard settings={settings} onChange={setSettings} />
            <ConnectionCard settings={settings} models={models} onTested={reload} />
          </div>
          <DefaultsCard settings={settings} models={models} onChange={setSettings} />
          <CatalogCard settings={settings} models={models} setModels={setModels} onDefault={(s) => setSettings(s)} reload={reload} />
          {usage && <UsageDashboard usage={usage} />}
          <Playground settings={settings} onFinished={() => void getAIUsage().then(setUsage)} />
        </>
      )}
    </AppShell>
  );
}

function StatusStrip({ settings, onChange }: { settings: AISettings; onChange: (s: AISettings) => void }) {
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      onChange(await patchAISettings({ paused: !settings.paused }));
    } finally {
      setBusy(false);
    }
  };
  const t = settings.last_test;
  return (
    <section
      aria-label="AI status"
      data-testid="ai-status"
      className={`glass-solid flex flex-wrap items-center gap-4 p-4 ${settings.paused ? "ring-2 ring-nx-error/60" : ""}`}
    >
      <span className="text-sm font-semibold text-nx-text">NVIDIA</span>
      {settings.key.present ? <Badge tone="ok">Key configured ({settings.key.source === "app" ? "saved in app" : "backend/.env"})</Badge> : <Badge tone="error">No API key</Badge>}
      {t.ok === true && <Badge tone="ok">Last test passed · {timeAgo(t.at)}</Badge>}
      {t.ok === false && <Badge tone="error">Last test failed · {timeAgo(t.at)}</Badge>}
      {t.ok === null && <Badge tone="neutral">Not tested yet</Badge>}
      {settings.default_model ? <Badge tone="info">Default: {settings.default_model}</Badge> : <Badge tone="warn">No default model</Badge>}
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        className={`ml-auto rounded-lg px-4 py-2 text-sm font-semibold ring-1 transition disabled:opacity-50 ${
          settings.paused ? "bg-nx-ok/15 text-nx-ok ring-nx-ok/40 hover:bg-nx-ok/25" : "bg-nx-error/15 text-nx-error ring-nx-error/40 hover:bg-nx-error/25"
        }`}
      >
        {settings.paused ? "Resume AI requests" : "Emergency stop"}
      </button>
      {settings.paused && (
        <p role="status" className="w-full text-xs text-nx-error">
          Emergency stop is active: no request leaves NEXUS AI until you resume.
        </p>
      )}
    </section>
  );
}

function KeyCard({ settings, onChange }: { settings: AISettings; onChange: (s: AISettings) => void }) {
  const [value, setValue] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null; message: string | null }>({ busy: false, error: null, message: null });
  const k = settings.key;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setState({ busy: true, error: null, message: null });
    try {
      onChange(await saveAIKey(value.trim()));
      setValue("");
      setState({ busy: false, error: null, message: "Saved (encrypted). Run a connection test." });
    } catch (err) {
      setState({ busy: false, error: aiErrorMessage(err), message: null });
    }
  };
  const remove = async () => {
    setState({ busy: true, error: null, message: null });
    try {
      onChange(await removeAIKey());
      setState({ busy: false, error: null, message: "Saved key removed." });
    } catch (err) {
      setState({ busy: false, error: aiErrorMessage(err), message: null });
    }
  };
  return (
    <Section id="key-title" title="API key" aside={<a href="https://build.nvidia.com" target="_blank" rel="noreferrer" className="text-nx-indigo hover:text-nx-cyan">Get a key at build.nvidia.com ↗</a>}>
      <p className="text-sm text-nx-muted" data-testid="key-status">
        {k.present
          ? k.source === "app"
            ? `Using the key saved in NEXUS AI (ends …${k.hint}), saved ${timeAgo(k.updated_at)}.`
            : `Using NVIDIA_API_KEY from backend/.env (ends …${k.hint}).`
          : "No key configured. Requests can't be made until you add one."}
      </p>
      <form onSubmit={save} className="mt-4 flex flex-wrap items-end gap-2">
        <label className={`${labelCls} min-w-60 flex-1`}>
          {k.present ? "Replace with a new key" : "Paste your key"}
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="nvapi-…"
            className={`${input} font-mono`}
            disabled={!k.can_save}
          />
        </label>
        <button type="submit" disabled={state.busy || value.trim().length < 20 || !k.can_save} className={primaryBtn}>
          Save key
        </button>
        {k.source === "app" && (
          <button type="button" onClick={() => void remove()} disabled={state.busy} className={ghostBtn}>
            Remove saved key
          </button>
        )}
      </form>
      <p className="mt-3 text-xs text-nx-faint">
        {k.can_save
          ? "Saved keys are encrypted with your local NEXUS_SECRET_KEY, stay on the server, and are never shown again — only the last four characters."
          : "Saving keys in the app needs NEXUS_SECRET_KEY (run make setup). You can still use NVIDIA_API_KEY in backend/.env."}
      </p>
      {state.message && <p role="status" className="mt-2 text-sm text-nx-ok">{state.message}</p>}
      {state.error && <p role="alert" className="mt-2 text-sm text-nx-error">{state.error}</p>}
    </Section>
  );
}

function ConnectionCard({ settings, models, onTested }: { settings: AISettings; models: AIModel[]; onTested: () => Promise<void> }) {
  const [model, setModel] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await testAIConnection(model || undefined));
      await onTested();
    } catch (err) {
      setError(aiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section id="test-title" title="Connection test" aside="Uses one small request">
      <div className="flex flex-wrap items-end gap-2">
        <label className={`${labelCls} min-w-60 flex-1`}>
          Model to test
          <select value={model} onChange={(e) => setModel(e.target.value)} className={input}>
            <option value="">{settings.default_model ? `Default (${settings.default_model})` : "None — key check only"}</option>
            {models.filter((m) => m.listed).map((m) => (
              <option key={m.id} value={m.id}>
                {m.verified_at ? "✓ " : ""}
                {m.id}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => void run()} disabled={busy || !settings.key.present} className={primaryBtn}>
          {busy ? "Testing…" : "Test connection"}
        </button>
      </div>
      {result && (
        <ol className="mt-4 space-y-2" data-testid="test-steps">
          {result.steps.map((s) => (
            <li key={s.name} className="flex items-start gap-3 rounded-lg bg-white/[0.03] px-3 py-2 text-sm ring-1 ring-nx-line">
              <span aria-hidden className={s.ok ? "text-nx-ok" : "text-nx-error"}>
                {s.ok ? "✓" : "✕"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-nx-text">{s.name}</span>
                <span className="block text-xs break-words text-nx-muted">{s.detail}</span>
              </span>
              {s.ms !== null && <span className="font-mono text-xs text-nx-faint">{s.ms} ms</span>}
            </li>
          ))}
        </ol>
      )}
      {!result && settings.last_test.message && <p className="mt-4 text-xs text-nx-faint">Last result: {settings.last_test.message}</p>}
      {error && <p role="alert" className="mt-3 text-sm text-nx-error">{error}</p>}
    </Section>
  );
}

function DefaultsCard({ settings, models, onChange }: { settings: AISettings; models: AIModel[]; onChange: (s: AISettings) => void }) {
  const [form, setForm] = useState(() => ({ ...settings }));
  const [state, setState] = useState<{ busy: boolean; error: string | null; message: string | null }>({ busy: false, error: null, message: null });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setState({ busy: true, error: null, message: null });
    try {
      const updated = await patchAISettings({
        base_url: form.base_url,
        default_model: form.default_model || null,
        max_output_tokens: Number(form.max_output_tokens),
        temperature: Number(form.temperature),
        timeout_seconds: Number(form.timeout_seconds),
        concurrency_limit: Number(form.concurrency_limit),
        daily_request_budget: Number(form.daily_request_budget),
        chat_thinking: form.chat_thinking,
      });
      onChange(updated);
      setState({ busy: false, error: null, message: "Saved." });
    } catch (err) {
      setState({ busy: false, error: aiErrorMessage(err), message: null });
    }
  };
  const num = (key: keyof typeof form) => ({
    value: String(form[key] ?? ""),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value }),
  });
  return (
    <form onSubmit={save} className="glass-solid p-5" aria-labelledby="defaults-title" data-testid="ai-defaults">
      <h2 id="defaults-title" className="text-sm font-semibold text-nx-text">
        Company defaults
      </h2>
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <label className={`${labelCls} md:col-span-2`}>
          Default model (used when a department or employee has none)
          <select value={form.default_model ?? ""} onChange={(e) => setForm({ ...form, default_model: e.target.value || null })} className={input}>
            <option value="">None</option>
            {models.filter((m) => m.listed).map((m) => (
              <option key={m.id} value={m.id}>
                {m.verified_at ? "✓ " : ""}
                {m.id}
              </option>
            ))}
          </select>
        </label>
        <label className={`${labelCls} md:col-span-2`}>
          Base URL
          <input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} className={`${input} font-mono`} />
        </label>
        <label className={labelCls}>
          Max output tokens
          <input type="number" min={16} max={16384} {...num("max_output_tokens")} className={input} />
        </label>
        <label className={labelCls}>
          Temperature
          <input type="number" min={0} max={2} step={0.1} {...num("temperature")} className={input} />
        </label>
        <label className={labelCls}>
          Timeout (seconds)
          <input type="number" min={5} max={600} {...num("timeout_seconds")} className={input} />
        </label>
        <label className={labelCls}>
          Concurrent requests
          <input type="number" min={1} max={16} {...num("concurrency_limit")} className={input} />
        </label>
        <label className={labelCls}>
          Daily request budget
          <input type="number" min={0} {...num("daily_request_budget")} className={input} />
        </label>
      </div>
      <label className="mt-4 flex items-start gap-2 text-sm text-nx-text">
        <input type="checkbox" className="mt-1" checked={form.chat_thinking} onChange={(e) => setForm({ ...form, chat_thinking: e.target.checked })} />
        <span>
          Think before replying in chat and voice
          <span className="block text-xs text-nx-faint">
            Off (recommended): employees answer directly — the first words arrive in about a second. On: reasoning models think first, which can take 5–15
            seconds per reply. Workflows and email drafts always think.
          </span>
        </span>
      </label>
      <p className="mt-3 text-xs text-nx-faint">
        Reasoning models spend part of the output tokens thinking; keep max output tokens comfortably above the reply length you expect. Departments also
        have their own budget and concurrency limits.
      </p>
      <div className="mt-4 flex items-center gap-3">
        <button type="submit" disabled={state.busy} className={primaryBtn}>
          Save defaults
        </button>
        {state.message && <span role="status" className="text-sm text-nx-ok">{state.message}</span>}
        {state.error && <span role="alert" className="text-sm text-nx-error">{state.error}</span>}
      </div>
    </form>
  );
}

function CatalogCard({
  settings,
  models,
  setModels,
  onDefault,
  reload,
}: {
  settings: AISettings;
  models: AIModel[];
  setModels: (m: AIModel[]) => void;
  onDefault: (s: AISettings) => void;
  reload: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const modelsRef = useRef(models);
  useEffect(() => {
    modelsRef.current = models;
  }, [models]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return models.filter((m) => m.listed || m.verified_at).filter((m) => !q || m.id.toLowerCase().includes(q));
  }, [models, query]);
  const verified = models.filter((m) => m.verified_at && m.listed).length;
  const unavailable = models.filter((m) => m.last_error?.includes("isn't available")).length;

  const refresh = async () => {
    setBusy("refresh");
    setError(null);
    try {
      await refreshAIModels();
      await reload();
    } catch (err) {
      setError(aiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const verify = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const row = await verifyAIModel(id);
      setModels(modelsRef.current.map((m) => (m.id === id ? row : m)));
    } catch (err) {
      setError(aiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const makeDefault = async (id: string) => {
    setBusy(`default:${id}`);
    try {
      onDefault(await patchAISettings({ default_model: id }));
    } catch (err) {
      setError(aiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section
      id="catalog-title"
      title="Model catalogue"
      aside={`${models.filter((m) => m.listed).length} listed · ${verified} verified · ${unavailable} not available to this key`}
    >
      <p className="mb-3 text-xs text-nx-faint">
        NVIDIA lists models that a given key may not be allowed to use. “Verify” sends one tiny request to check; only verified models are recommended.
      </p>
      <div className="flex flex-wrap gap-2">
        <input type="search" aria-label="Filter models" placeholder="Filter models…" value={query} onChange={(e) => setQuery(e.target.value)} className={`${input} mt-0 max-w-xs`} />
        <button type="button" onClick={() => void refresh()} disabled={busy !== null || !settings.key.present} className={ghostBtn}>
          {busy === "refresh" ? "Refreshing…" : models.length ? "Refresh list" : "Load model list"}
        </button>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-nx-error">{error}</p>}
      <ul className="mt-4 max-h-96 divide-y divide-nx-line overflow-y-auto rounded-xl ring-1 ring-nx-line" data-testid="model-list">
        {shown.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5" data-model={m.id}>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-sm text-nx-text">{m.id}</span>
              {m.last_error && <span className="block truncate text-xs text-nx-faint" title={m.last_error}>{m.last_error}</span>}
            </span>
            {modelBadge(m)}
            {settings.default_model === m.id ? (
              <Badge tone="info">Default</Badge>
            ) : (
              <button type="button" onClick={() => void makeDefault(m.id)} disabled={busy !== null || !m.listed} className="text-xs text-nx-indigo hover:text-nx-cyan disabled:opacity-40">
                Set default
              </button>
            )}
            <button type="button" onClick={() => void verify(m.id)} disabled={busy !== null} className="rounded-md px-2.5 py-1 text-xs text-nx-muted ring-1 ring-nx-line-strong hover:text-nx-text disabled:opacity-40" aria-label={`Verify ${m.id}`}>
              {busy === m.id ? "Checking…" : "Verify"}
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="px-4 py-6 text-center text-sm text-nx-muted">{models.length ? "No models match." : "No models loaded yet."}</li>}
      </ul>
    </Section>
  );
}
