"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { AppShell } from "@/components/org/AppShell";
import { type Addressee, chatHref, parseTarget } from "@/lib/routing";
import { startChatSync, useChatStore } from "@/world/state/chatStore";

import { ConversationList } from "./ConversationList";
import { ConversationView } from "./ConversationView";
import { NewConversation } from "./NewConversation";

/**
 * /chat                    → conversation list + "start a conversation"
 * /chat?c=<id>[&m=<msg>]   → an existing conversation (optionally highlighting a message)
 * /chat?to=employee:<id>   → a new conversation with an employee (created on first send)
 * /chat?to=department:<key>
 * /chat?new=1              → the picker
 */
export function ChatPage() {
  const params = useSearchParams();
  const router = useRouter();
  const activeId = params.get("c");
  const target = parseTarget(params.get("to"));
  const picking = params.get("new") === "1";
  const highlight = Number(params.get("m")) || null;
  const conversation = useChatStore((s) => (activeId ? s.conversations.find((c) => c.id === activeId) : undefined));
  const listLoad = useChatStore((s) => s.listLoad);

  useEffect(() => {
    const stop = startChatSync();
    void useChatStore.getState().loadConversations();
    return stop;
  }, []);

  const [missingId, setMissingId] = useState<string | null>(null);
  useEffect(() => {
    if (!activeId || conversation || listLoad !== "ready") return;
    let live = true;
    void useChatStore
      .getState()
      .ensureConversation(activeId)
      .then((found) => live && !found && setMissingId(activeId));
    return () => {
      live = false;
    };
  }, [activeId, conversation, listLoad]);

  const go = (query: string) => router.replace(`/chat${query}`, { scroll: false });
  const select = (id: string) => {
    const match = useChatStore.getState().conversations.find((c) => c.id === id)?.match;
    go(`?c=${id}${match?.message_id ? `&m=${match.message_id}` : ""}`);
  };
  const pick = (to: Addressee) => router.replace(chatHref(to), { scroll: false });

  const missing = activeId && !conversation && missingId === activeId;
  const showView = Boolean((activeId && conversation) || target);

  return (
    <AppShell
      title="Chat"
      subtitle="Message the CEO, a department or any employee. Each reply comes from that employee's routed NVIDIA model and is saved here."
    >
      <div className="glass-solid flex h-[calc(100dvh-2rem)] min-h-[30rem] lg:h-[calc(100dvh-13.5rem)] overflow-hidden p-0" data-testid="chat">
        <aside className={`w-full flex-col border-nx-line lg:flex lg:w-80 lg:shrink-0 lg:border-r ${showView || picking ? "hidden" : "flex"}`} aria-label="Conversation list">
          <ConversationList activeId={activeId} onSelect={select} onNew={() => go("?new=1")} />
        </aside>
        <main className={`min-w-0 flex-1 flex-col ${showView || picking ? "flex" : "hidden lg:flex"}`}>
          {activeId && conversation ? (
            <ConversationView
              key={activeId}
              conversation={conversation}
              target={{ kind: conversation.kind, employee_id: conversation.employee_id, department: conversation.department }}
              onCreated={select}
              onDeleted={() => go("")}
              onBack={() => go("")}
              highlightMessage={highlight}
            />
          ) : target ? (
            <ConversationView key={params.get("to")} conversation={null} target={target} onCreated={select} onDeleted={() => go("")} onBack={() => go("")} highlightMessage={null} />
          ) : missing ? (
            <p className="p-6 text-sm text-nx-muted">That conversation doesn&apos;t exist (it may have been deleted).</p>
          ) : activeId ? (
            <p className="p-6 text-sm text-nx-muted">Loading…</p>
          ) : (
            <NewConversation onPick={pick} />
          )}
        </main>
      </div>
    </AppShell>
  );
}
