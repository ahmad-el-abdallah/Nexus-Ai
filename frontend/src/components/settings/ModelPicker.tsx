"use client";

import { useEffect } from "react";

import { useAIStore } from "@/world/state/aiStore";

/** Model override picker: only models the provider lists; verified ones first. */
export function ModelPicker({ value, onChange, inheritLabel, className, label }: { value: string | null; onChange: (v: string | null) => void; inheritLabel: string; className: string; label: string }) {
  const models = useAIStore((s) => s.models);
  const refresh = useAIStore((s) => s.refresh);
  useEffect(() => {
    if (models.length === 0) void refresh();
  }, [models.length, refresh]);
  const listed = models.filter((m) => m.listed).sort((a, b) => Number(!!b.verified_at) - Number(!!a.verified_at) || a.id.localeCompare(b.id));
  return (
    <select aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} className={className}>
      <option value="">{inheritLabel}</option>
      {listed.map((m) => (
        <option key={m.id} value={m.id}>
          {m.verified_at ? "✓ " : ""}
          {m.id}
        </option>
      ))}
      {value && !listed.some((m) => m.id === value) && <option value={value}>{value} (not in catalogue)</option>}
    </select>
  );
}
