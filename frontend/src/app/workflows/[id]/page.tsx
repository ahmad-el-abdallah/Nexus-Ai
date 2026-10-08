import { Suspense } from "react";

import { WorkflowDetailPage } from "@/components/workflows/WorkflowDetailPage";

export const metadata = { title: "Workflow · NEXUS AI" };

export default function Page({ params }: PageProps<"/workflows/[id]">) {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-nx-muted">Loading…</p>}>
      {params.then(({ id }) => (
        <WorkflowDetailPage key={id} id={id} />
      ))}
    </Suspense>
  );
}
