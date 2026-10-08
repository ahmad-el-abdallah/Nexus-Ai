import { Suspense } from "react";

import { DepartmentPage } from "@/components/org/DepartmentPage";

export const metadata = { title: "Department · NEXUS AI" };

export default function Page({ params }: PageProps<"/departments/[key]">) {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-nx-muted">Loading…</p>}>
      {params.then(({ key }) => (
        <DepartmentPage key={key} departmentKey={key} />
      ))}
    </Suspense>
  );
}
