/** Formatting shared by the Vault screens. */

export function bytes(value: number | null): string {
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

export function when(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

/** "ws_department:human-resources" → "Human Resources" (the company workspace has its own name). */
export function workspaceLabel(id: string | null): string {
  if (!id) return "Whole vault";
  if (id === "ws_company") return "Company Vault";
  return id.replace("ws_department:", "").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
