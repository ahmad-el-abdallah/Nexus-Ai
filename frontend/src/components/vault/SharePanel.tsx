"use client";

import { useEffect, useState } from "react";

import { fetchDepartments, type Department } from "@/lib/departments";
import { fetchEmployees, type Employee } from "@/lib/employees";
import { createGrant, fetchGrants, revokeGrant, type StorageEntryDetail, type StorageGrantDetail } from "@/lib/storage";

import { when } from "./format";

const FIELD = "w-full rounded-lg bg-nx-bg-raised px-2 py-2 text-xs text-nx-text ring-1 ring-nx-line";
const EXPIRY = [
  { value: "", label: "No expiry" },
  { value: "7", label: "For 7 days" },
  { value: "30", label: "For 30 days" },
];

interface Props {
  detail: StorageEntryDetail;
  busy: boolean;
  onAction: (action: () => Promise<unknown>, clear?: boolean) => void;
}

/** Who else can reach this item, and a form to share it. The backend enforces every grant. */
export function SharePanel({ detail, busy, onAction }: Props) {
  const [grants, setGrants] = useState<StorageGrantDetail[] | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [kind, setKind] = useState<"department" | "employee">("department");
  const [grantee, setGrantee] = useState("");
  const [permission, setPermission] = useState<"read" | "write">("read");
  const [days, setDays] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    void fetchGrants(detail.id)
      .then((value) => active && setGrants(value))
      .catch((caught: Error) => active && setError(caught.message));
    return () => {
      active = false;
    };
  }, [detail.id, revision]);

  useEffect(() => {
    let active = true;
    void Promise.all([fetchDepartments(), fetchEmployees()])
      .then(([departmentRows, employeeRows]) => {
        if (!active) return;
        setDepartments(departmentRows);
        setEmployees(employeeRows);
      })
      .catch((caught: Error) => active && setError(caught.message));
    return () => {
      active = false;
    };
  }, []);

  const ownDepartment = detail.workspace_id.startsWith("ws_department:") ? detail.workspace_id.replace("ws_department:", "") : null;
  const choices = kind === "department"
    ? departments.filter((department) => department.key !== ownDepartment).map((department) => ({ id: department.key, label: department.name }))
    : employees.filter((employee) => employee.department !== ownDepartment).map((employee) => ({ id: employee.id, label: `${employee.name} — ${employee.role}` }));
  const reload = () => setRevision((value) => value + 1);
  const share = () => onAction(() => createGrant(detail.workspace_id, {
    grantee_kind: kind,
    grantee_id: grantee,
    permission,
    entry_id: detail.id,
    expires_at: days ? new Date(Date.now() + Number(days) * 86_400_000).toISOString() : null,
  }).then(() => {
    setGrantee("");
    reload();
  }));

  return (
    <section aria-label="Sharing">
      <h3 className="font-medium text-nx-text">Sharing · {grants?.length ?? "…"}</h3>
      {error && <p role="alert" className="mt-1 text-nx-error">{error}</p>}
      {grants && (grants.length === 0 ? (
        <p className="mt-1 text-nx-faint">{ownDepartment ? "Only this department can open it." : "Every employee can read the Company Vault; only you can change it."}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {grants.map((grant) => (
            <li key={grant.id} className="flex items-start justify-between gap-2" data-testid="item-grant">
              <span className="min-w-0">
                <span className="block truncate text-nx-muted">{grant.grantee_name ?? grant.grantee_id} · {grant.permission === "read" ? "can read" : grant.permission === "write" ? "can read and change" : "can manage"}</span>
                <span className="block truncate text-[10px] text-nx-faint">{grant.inherited ? `through ${grant.entry_name ? `the folder ${grant.entry_name}` : "the whole workspace"}` : "shared directly"} · {grant.expires_at ? `until ${when(grant.expires_at)}` : "no expiry"}</span>
              </span>
              {!grant.inherited && <button disabled={busy} onClick={() => onAction(() => revokeGrant(grant.id).then(reload))} aria-label={`Revoke access of ${grant.grantee_name ?? grant.grantee_id}`} className="shrink-0 rounded px-2 py-1 text-[11px] text-nx-error ring-1 ring-nx-error/30 disabled:opacity-40">Revoke</button>}
            </li>
          ))}
        </ul>
      ))}
      {!detail.trashed_at && (
        <div className="mt-3 space-y-2 rounded-xl bg-white/[0.025] p-3 ring-1 ring-nx-line">
          <div className="grid grid-cols-2 gap-2">
            <select aria-label="Share with a department or an employee" value={kind} onChange={(event) => { setKind(event.target.value as typeof kind); setGrantee(""); }} className={FIELD}>
              <option value="department">A department</option>
              <option value="employee">One employee</option>
            </select>
            <select aria-label="Access level" value={permission} onChange={(event) => setPermission(event.target.value as typeof permission)} className={FIELD}>
              <option value="read">Can read</option>
              <option value="write">Can read and change</option>
            </select>
          </div>
          <select aria-label="Share with" value={grantee} onChange={(event) => setGrantee(event.target.value)} className={FIELD}>
            <option value="">Choose who to share with…</option>
            {choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
          </select>
          <select aria-label="Access duration" value={days} onChange={(event) => setDays(event.target.value)} className={FIELD}>
            {EXPIRY.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button disabled={busy || !grantee} onClick={share} className="w-full rounded-lg px-3 py-2 text-xs text-nx-text ring-1 ring-nx-line disabled:opacity-40">Share</button>
        </div>
      )}
    </section>
  );
}
