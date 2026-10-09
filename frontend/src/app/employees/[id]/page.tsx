import { Suspense } from "react";

import { ProfilePage } from "@/components/employees/ProfilePage";

export const metadata = { title: "Employee · NEXUS AI" };

export default function Page({ params }: PageProps<"/employees/[id]">) {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-nx-muted">Loading…</p>}>
      {params.then(({ id }) => (
        <ProfilePage key={id} id={id} />
      ))}
    </Suspense>
  );
}
