import { Suspense } from "react";

import { ChatPage } from "@/components/chat/ChatPage";

export const metadata = { title: "Chat · NEXUS AI" };

export default function Page() {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-nx-muted">Loading…</p>}>
      <ChatPage />
    </Suspense>
  );
}
