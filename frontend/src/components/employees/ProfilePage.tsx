"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { EmployeeEditor } from "@/components/hq/EmployeeEditor";
import { Initials } from "@/components/hq/people";
import { AppShell, LoadState } from "@/components/org/AppShell";
import { Badge, ghostBtn, input, primaryBtn, Section, timeAgo } from "@/components/settings/ui";
import type { Employee } from "@/lib/employees";
import { liveEvents } from "@/lib/events";
import { addFeedback, deleteFeedback, fetchProfile, HISTORY_LABEL, type Profile, saveSkills } from "@/lib/profiles";
import { useEmployeeStore } from "@/world/state/employeeStore";

type Tone = "ok" | "warn" | "error" | "neutral" | "info";

const TASK_TONE: Record<string, Tone> = {
  done: "ok",
  failed: "error",
  running: "info",
  reviewing: "info",
  awaiting_review: "warn",
  queued: "neutral",
  open: "neutral",
};

function Stars({ value }: { value: number }) {
  const n = Math.round(value);
  return (
    <span aria-label={`${value} out of 5`} className="text-nx-cyan">
      {"★".repeat(n)}
      <span className="text-nx-line-strong">{"★".repeat(5 - n)}</span>
    </span>
  );
}

function SkillsCard({ profile, onChange }: { profile: Profile; onChange: () => void }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (skills: string[]) => {
    setBusy(true);
    try {
      await saveSkills(profile.id, skills);
      onChange();
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    const skill = draft.trim();
    if (skill && !profile.skills.some((s) => s.toLowerCase() === skill.toLowerCase())) void save([...profile.skills, skill]);
    setDraft("");
  };
  return (
    <Section id="skills" title="Skills">
      {profile.skills.length === 0 ? (
        <p className="text-sm text-nx-muted">No skills added yet. Add the ones this employee is responsible for.</p>
      ) : (
        <ul className="flex flex-wrap gap-2" aria-label="Skills">
          {profile.skills.map((s) => (
            <li key={s} className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 text-xs text-nx-text ring-1 ring-nx-line-strong">
              {s}
              <button type="button" aria-label={`Remove ${s}`} disabled={busy} onClick={() => void save(profile.skills.filter((x) => x !== s))} className="text-nx-faint hover:text-nx-error">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={40} placeholder="Add a skill…" className={input} aria-label="Add a skill" />
        <button type="submit" disabled={busy || !draft.trim()} className={ghostBtn}>
          Add
        </button>
      </form>
    </Section>
  );
}

function PerformanceCard({ profile }: { profile: Profile }) {
  const p = profile.performance;
  const stat = (label: string, value: number, tone = "text-nx-text") => (
    <div className="rounded-lg bg-white/[0.02] p-3 ring-1 ring-nx-line">
      <p className="text-[11px] tracking-wider text-nx-faint uppercase">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${tone}`}>{value}</p>
    </div>
  );
  return (
    <Section id="performance" title="Performance" aside="From verified work only">
      {p.success_rate === null ? (
        <p className="text-sm text-nx-muted">Not enough data yet — no finished tasks or sandbox runs. A score appears once this employee has completed real work.</p>
      ) : (
        <>
          <div className="mb-3 flex items-baseline gap-3">
            <span className="text-3xl font-bold text-nx-text">{p.success_rate}%</span>
            <span className="text-sm text-nx-muted">{p.basis}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {stat("Tasks done", p.tasks_done, "text-nx-ok")}
            {stat("Tasks failed", p.tasks_failed, p.tasks_failed ? "text-nx-error" : "text-nx-text")}
            {stat("Runs ok", p.runs_succeeded, "text-nx-ok")}
            {stat("Revisions asked", p.revisions_requested)}
          </div>
        </>
      )}
      <p className="mt-3 text-[11px] text-nx-faint">Computed live from recorded tasks, sandbox runs and supervisor reviews. NEXUS never invents a score.</p>
    </Section>
  );
}

function RatingCard({ profile, onChange }: { profile: Profile; onChange: () => void }) {
  const [rating, setRating] = useState(0);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!rating && !note.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addFeedback(profile.id, { rating: rating || null, note: note.trim() || null });
      setRating(0);
      setNote("");
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      id="rating"
      title="Owner rating & feedback"
      aside={
        profile.rating.average !== null ? (
          <span>
            <Stars value={profile.rating.average} /> {profile.rating.average} ({profile.rating.count})
          </span>
        ) : (
          "No ratings yet"
        )
      }
    >
      <div className="flex items-center gap-1" role="radiogroup" aria-label="Your rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} star${n > 1 ? "s" : ""}`} onClick={() => setRating(n === rating ? 0 : n)} className={`text-2xl ${n <= rating ? "text-nx-cyan" : "text-nx-line-strong hover:text-nx-muted"}`}>
            ★
          </button>
        ))}
        {rating > 0 && <span className="ml-1 text-xs text-nx-faint">{rating}/5</span>}
      </div>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={4000} placeholder="Optional note (what they did well, what to improve)…" className={`${input} mt-2 h-auto py-2`} aria-label="Feedback note" />
      <div className="mt-2 flex items-center gap-3">
        <button type="button" disabled={busy || (!rating && !note.trim())} onClick={() => void submit()} className={primaryBtn}>
          {busy ? "Saving…" : "Add feedback"}
        </button>
        {error && (
          <span role="alert" className="text-xs text-nx-error">
            {error}
          </span>
        )}
      </div>
      {profile.feedback.length > 0 && (
        <ul className="mt-4 space-y-2" aria-label="Feedback history">
          {profile.feedback.map((f) => (
            <li key={f.id} className="rounded-lg bg-white/[0.02] p-3 text-sm ring-1 ring-nx-line">
              <div className="flex items-center justify-between gap-2">
                <span>{f.rating !== null ? <Stars value={f.rating} /> : <span className="text-nx-faint">Note</span>}</span>
                <span className="flex items-center gap-2 text-[11px] text-nx-faint">
                  {timeAgo(f.created_at)}
                  <button type="button" aria-label="Delete feedback" onClick={() => void deleteFeedback(profile.id, f.id).then(onChange)} className="hover:text-nx-error">
                    ×
                  </button>
                </span>
              </div>
              {f.note && <p className="mt-1 text-nx-muted">{f.note}</p>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function TaskList({ title, tasks, empty }: { title: string; tasks: Profile["task_history"]; empty: string }) {
  return (
    <Section id={title.toLowerCase().replace(/\s+/g, "-")} title={title} aside={tasks.length ? String(tasks.length) : undefined}>
      {tasks.length === 0 ? (
        <p className="text-sm text-nx-muted">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2 rounded-lg bg-white/[0.02] p-3 text-sm ring-1 ring-nx-line">
              <div className="min-w-0">
                <p className="truncate text-nx-text">{t.title}</p>
                <p className="text-[11px] text-nx-faint">
                  {t.workflow_id ? "workflow task" : "direct task"}
                  {t.revisions > 0 ? ` · revised ${t.revisions}×` : ""} · {timeAgo(t.finished_at ?? t.created_at)}
                  {t.workflow_id && (
                    <>
                      {" · "}
                      <Link href={`/workflows/${t.workflow_id}`} className="text-nx-indigo hover:text-nx-cyan">
                        open
                      </Link>
                    </>
                  )}
                </p>
              </div>
              <Badge tone={TASK_TONE[t.status] ?? "neutral"}>{t.status.replace("_", " ")}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function ProfilePage({ id }: { id: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const employee = useEmployeeStore((s) => s.employees.find((e) => e.id === id));

  const load = useCallback(async () => {
    try {
      setProfile(await fetchProfile(id));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const release = liveEvents.retain();
    const off = [
      liveEvents.on("employee.profile", (d) => (d as { id: string }).id === id && void load()),
      liveEvents.on("employee.updated", (d) => (d as Employee).id === id && void load()),
      liveEvents.on("task.updated", () => void load()),
      liveEvents.on("run.updated", () => void load()),
      liveEvents.onStatus((_s, again) => again && void load()),
    ];
    return () => {
      clearTimeout(first);
      off.forEach((f) => f());
      release();
    };
  }, [id, load]);

  const office = profile?.desk_id ? profile.desk_id.replace(/-desk-/, " · desk ").replace(/-/g, " ") : "Remote — no desk";

  return (
    <AppShell
      title={profile?.name ?? "Employee"}
      subtitle={profile ? `${profile.role} · ${profile.department_name}` : undefined}
      actions={
        profile && (
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/chat?to=employee:${profile.id}`} className={primaryBtn}>
              Message
            </Link>
            {employee && (
              <button type="button" className={ghostBtn} onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
            <Link href="/org" className={ghostBtn}>
              Org chart
            </Link>
          </div>
        )
      }
    >
      <LoadState load={error ? "error" : profile ? "ready" : "loading"} error={error} />
      {profile && (
        <>
          <div className="glass-solid flex flex-wrap items-center gap-4 p-5">
            {employee ? (
              <Initials employee={employee} size="size-16" />
            ) : (
              <span className="flex size-16 items-center justify-center rounded-full bg-nx-violet/30 text-xl font-semibold text-white">
                {profile.name
                  .split(/\s+/)
                  .map((p) => p[0])
                  .slice(0, 2)
                  .join("")}
              </span>
            )}
            <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
              {(
                [
                  ["Seniority", profile.seniority],
                  ["Office", office],
                  ["Reports to", profile.manager?.name ?? "the owner"],
                  ["Direct reports", profile.reports.length ? String(profile.reports.length) : "none"],
                  ["AI model", profile.model_id ?? "company default"],
                  ["Status", profile.status + (profile.status_detail ? ` — ${profile.status_detail}` : "")],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-[11px] tracking-wider text-nx-faint uppercase">{k}</dt>
                  <dd className="truncate text-nx-text" title={v}>
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-5">
              <PerformanceCard profile={profile} />
              <TaskList title="Active assignments" tasks={profile.active_assignments} empty="No active assignments right now." />
              <TaskList title="Task history" tasks={profile.task_history} empty="No finished tasks yet." />
            </div>
            <div className="space-y-5">
              <SkillsCard profile={profile} onChange={() => void load()} />
              <RatingCard profile={profile} onChange={() => void load()} />
              {profile.reports.length > 0 && (
                <Section id="reports" title={`Team (${profile.reports.length})`}>
                  <ul className="flex flex-wrap gap-2">
                    {profile.reports.map((r) => (
                      <li key={r.id}>
                        <Link href={`/employees/${r.id}`} className="rounded-lg bg-white/5 px-2.5 py-1 text-xs text-nx-text ring-1 ring-nx-line-strong hover:text-nx-cyan" title={r.role}>
                          {r.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
              <Section id="history" title="History">
                {profile.history.length === 0 ? (
                  <p className="text-sm text-nx-muted">Nothing recorded yet.</p>
                ) : (
                  <ol className="space-y-1.5 text-sm" aria-label="Change history">
                    {profile.history.map((h) => (
                      <li key={h.id} className="flex gap-3">
                        <span className="w-20 shrink-0 text-[11px] text-nx-faint">{timeAgo(h.created_at)}</span>
                        <span className="text-nx-muted">
                          <span className="font-medium text-nx-text">{HISTORY_LABEL[h.kind] ?? h.kind}</span> — {h.text}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </Section>
            </div>
          </div>
        </>
      )}
      {editing && employee && <EmployeeEditor employee={employee} onClose={() => setEditing(false)} onSaved={() => void load()} />}
    </AppShell>
  );
}
