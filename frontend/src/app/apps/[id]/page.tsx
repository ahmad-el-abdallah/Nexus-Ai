import { Suspense } from "react";

import { AppDetailPage } from "@/components/apps/AppDetailPage";

export const metadata = { title: "App · NEXUS AI" };

export default function Page({ params }: PageProps<"/apps/[id]">) {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-nx-muted">Loading…</p>}>
      {params.then(({ id }) => (
        <AppDetailPage key={id} id={id} />
      ))}
    </Suspense>
  );
}
