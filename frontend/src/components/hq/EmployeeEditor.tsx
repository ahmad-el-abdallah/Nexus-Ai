"use client";

import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";

import { type Employee, type EmployeeDraft, SENIORITY, type Seniority } from "@/lib/employees";
import { ModelPicker } from "@/components/settings/ModelPicker";
import { WORKSTATIONS } from "@/world/layout/building";
import { useAIStore } from "@/world/state/aiStore";
import { ROOM_BY_ID } from "@/world/layout/queries";
import { useDepartmentStore } from "@/world/state/departmentStore";
import { useEmployeeStore } from "@/world/state/employeeStore";

const field =
  "mt-1 h-10 w-full rounded-lg bg-nx-bg/80 px-3 text-sm text-nx-text ring-1 ring-nx-line-strong focus:ring-nx-violet/60 focus:outline-none";
const label = "block text-xs font-medium text-nx-muted";

interface Props {
  /** Edit this employee, or hire a new one when omitted. */
  employee?: Employee;
  /** Preselected department when hiring. */
  department?: string;
  onClose: () => void;
  onSaved?: (employee: Employee) => void;
  onDeleted?: () => void;
}

/** Hire or edit an AI employee. Every rule is enforced (and explained) by the backend. */
export function EmployeeEditor({ employee, department, onClose, onSaved, onDeleted }: Props) {
  const departments = useDepartmentStore((s) => s.departments);
  const employees = useEmployeeStore((s) => s.employees);
  const hire = useEmployeeStore((s) => s.hire);
  const edit = useEmployeeStore((s) => s.edit);
  const remove = useEmployeeStore((s) => s.remove);
  const titleId = useId();
  const firstField = useRef<HTMLInputElement>(null);

  const initialDept = employee?.department ?? department ?? departments[0]?.key ?? "";
  const [draft, setDraft] = useState<EmployeeDraft>(() => ({
    name: employee?.name ?? "",
    department: initialDept,
    role: employee?.role ?? departments.find((d) => d.key === initialDept)?.roles[1] ?? "",
    seniority: (employee?.seniority as Seniority) ?? "mid",
    desk_id: employee?.desk_id ?? null,
    supervisor_id: employee?.supervisor_id ?? null,
    model_id: employee?.model_id ?? null,
  }));
  const [supervisorTouched, setSupervisorTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => firstField.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dept = departments.find((d) => d.key === draft.department);
  const takenDesks = useMemo(
    () => new Set(employees.filter((e) => e.desk_id && e.id !== employee?.id).map((e) => e.desk_id!)),
    [employees, employee?.id],
  );
  const freeDesksByRoom = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const ws of WORKSTATIONS) {
      if (takenDesks.has(ws.id)) continue;
      const room = ROOM_BY_ID.get(ws.room)?.name ?? ws.room;
      groups.set(room, [...(groups.get(room) ?? []), ws.id]);
    }
    return [...groups.entries()];
  }, [takenDesks]);
  const supervisors = employees.filter((e) => e.id !== employee?.id).sort((a, b) => a.name.localeCompare(b.name));
  const reports = employee ? employees.filter((e) => e.supervisor_id === employee.id) : [];
  const manager = employee?.supervisor_id ? employees.find((e) => e.id === employee.supervisor_id) : undefined;

  const set = <K extends keyof EmployeeDraft>(key: K, value: EmployeeDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const onDepartment = (key: string) => {
    const next = departments.find((d) => d.key === key);
    setDraft((d) => ({
      ...d,
      department: key,
      // Keep the role if the new department has it, otherwise suggest its first non-director role.
      role: next?.roles.includes(d.role) ? d.role : (next?.roles[1] ?? next?.roles[0] ?? ""),
    }));
    if (!supervisorTouched) setDraft((d) => ({ ...d, supervisor_id: null }));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body: Partial<EmployeeDraft> = { ...draft };
      // Unless the owner picked a supervisor, let the backend apply the default
      // (the department director) rather than sending a stale one.
      if (!supervisorTouched) delete body.supervisor_id;
      if (!employee) delete body.model_id; // new hires inherit; set an override after hiring
      const saved = employee ? await edit(employee.id, body) : await hire(body as EmployeeDraft);
      void useAIStore.getState().refresh();
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function doDelete() {
    if (!employee) return;
    setSaving(true);
    setError(null);
    try {
      await remove(employee.id);
      onDeleted?.();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setConfirmDelete(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="employee-editor"
        onSubmit={submit}
        className="glass-solid max-h-[90vh] w-full max-w-lg overflow-y-auto p-6"
      >
        <h2 id={titleId} className="text-lg font-semibold text-nx-text">
          {employee ? `Edit ${employee.name}` : "Hire an AI employee"}
        </h2>
        <p className="mt-1 text-xs text-nx-faint">
          {employee
            ? "Changes apply immediately and are saved to the database."
            : "Creates the employee's configuration. No AI model runs until the NVIDIA connection (Stage 5)."}
        </p>

        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className={`${label} sm:col-span-2`}>
            Name
            <input ref={firstField} required minLength={2} maxLength={80} value={draft.name} onChange={(e) => set("name", e.target.value)} className={field} />
          </label>
          <label className={label}>
            Department
            <select value={draft.department} onChange={(e) => onDepartment(e.target.value)} className={field}>
              {departments.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            Role
            <select value={draft.role} onChange={(e) => set("role", e.target.value)} className={field}>
              {dept?.roles.map((r, i) => (
                <option key={r} value={r}>
                  {r}
                  {i === 0 ? " (director role)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            Seniority
            <select value={draft.seniority} onChange={(e) => set("seniority", e.target.value as Seniority)} className={field}>
              {SENIORITY.map((s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            Desk
            <select value={draft.desk_id ?? ""} onChange={(e) => set("desk_id", e.target.value || null)} className={field}>
              <option value="">No desk (remote)</option>
              {freeDesksByRoom.map(([room, desks]) => (
                <optgroup key={room} label={room}>
                  {desks.map((d) => (
                    <option key={d} value={d}>
                      {room} · desk {d.split("-").pop()}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {employee && (
            <label className={`${label} sm:col-span-2`}>
              AI model
              <ModelPicker label="AI model" value={draft.model_id ?? null} onChange={(v) => set("model_id", v)} inheritLabel="Department / company default" className={field} />
            </label>
          )}
          <label className={`${label} sm:col-span-2`}>
            Reports to
            <select
              value={supervisorTouched ? (draft.supervisor_id ?? "") : ""}
              onChange={(e) => {
                setSupervisorTouched(e.target.value !== "");
                set("supervisor_id", e.target.value || null);
              }}
              className={field}
            >
              <option value="">
                {employee && draft.department === employee.department && manager
                  ? `Keep current (${manager.name})`
                  : "Department director (default)"}
              </option>
              {supervisors.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {s.role}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && (
          <p role="alert" className="mt-4 rounded-lg bg-nx-error/10 px-3 py-2 text-sm text-nx-error ring-1 ring-nx-error/30">
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          {employee ? (
            confirmDelete ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-nx-muted">
                <span>
                  Remove {employee.name}?{reports.length > 0 && ` ${reports.length} report(s) will move to ${manager?.name ?? "their manager"}.`}
                </span>
                <button type="button" onClick={() => void doDelete()} disabled={saving} className="rounded-lg bg-nx-error/20 px-3 py-1.5 font-semibold text-nx-error ring-1 ring-nx-error/40">
                  Yes, remove
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="rounded-lg px-3 py-1.5 ring-1 ring-nx-line-strong">
                  Keep
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirmDelete(true)} className="text-xs font-medium text-nx-error hover:underline">
                Remove employee…
              </button>
            )
          ) : (
            <span />
          )}
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-nx-muted ring-1 ring-nx-line-strong hover:text-nx-text">
              Cancel
            </button>
            <button type="submit" disabled={saving || !draft.name.trim()} className="rounded-lg bg-nx-violet/30 px-4 py-2 text-sm font-semibold text-white ring-1 ring-nx-violet/60 hover:bg-nx-violet/40 disabled:opacity-50">
              {saving ? "Saving…" : employee ? "Save changes" : "Hire employee"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
