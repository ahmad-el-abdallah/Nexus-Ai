"use client";

import { useEffect, useState } from "react";

import { Initials, relativeTime } from "@/components/hq/people";
import type { Conversation } from "@/lib/chat";
import { useChatStore } from "@/world/state/chatStore";
import { useDepartmentStore } from "@/world/state/departmentStore";
import { useEmployeeStore } from "@/world/state/employeeStore";

export function TargetAvatar({ conversation, size = "size-9" }: { conversation: Pick<Conversation, "kind" | "employee_id" | "department">; size?: string }) {
  const employee = useEmployeeStore((s) => (conversation.employee_id ? s.employees.find((e) => e.id === conversation.employee_id) : undefined));
  const department = useDepartmentStore((s) => s.departments.find((d) => d.key === conversation.department));
  if (conversation.kind === "employee" && employee) return <Initials employee={employee} size={size} />;
  const color = department?.color ?? "#94a3b8";
  return (
    <span aria-hidden className={`${size} grid shrink-0 place-items-center rounded-xl text-xs font-bold`} style={{ background: `${color}22`, color, boxShadow: `inset 0 0 0 1px ${color}55` }}>
      {(department?.name ?? conversation.department).slice(0, 2).toUpperCase()}
    </span>
  );
}

export function useTargetName(conversation: Pick<Conversation, "kind" | "employee_id" | "department">): string {
  const employee = useEmployeeStore((s) => (conversation.employee_id ? s.employees.find((e) => e.id === conversation.employee_id) : undefined));
  const department = useDepartmentStore((s) => s.departments.find((d) => d.key === conversation.department));
  if (conversation.kind === "employee") return employee?.name ?? "Former employee";
  return `${department?.name ?? conversation.department} department`;
}

function Row({ conversation, active, onSelect }: { conversation: Conversation; active: boolean; onSelect: () => void }) {
  const target = useTargetName(conversation);
  const reply = useChatStore((s) => s.replies[conversation.id]);
  const replying = Boolean(reply) || conversation.replying;
  const preview = conversation.match?.snippet ?? conversation.last_message?.snippet;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition ${active ? "bg-white/[0.07] ring-1 ring-nx-line-strong" : "hover:bg-white/[0.04]"}`}
      >
        <TargetAvatar conversation={conversation} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium text-nx-text">{conversation.title}</span>
            <span className="shrink-0 text-[10px] text-nx-faint">{relativeTime(conversation.last_message_at ?? conversation.created_at)}</span>
          </span>
          <span className="block truncate text-xs text-nx-muted">{target}</span>
          {replying ? (
            <span className="mt-0.5 flex items-center gap-1.5 text-xs text-nx-cyan">
              <span className="nx-pulse size-1.5 rounded-full bg-nx-cyan" />
              Replying…
            </span>
          ) : (
            preview && (
              <span className={`mt-0.5 block truncate text-xs ${conversation.last_message?.status === "error" && !conversation.match ? "text-nx-error/80" : "text-nx-faint"}`}>
                {conversation.match ? "" : conversation.last_message?.role === "owner" ? "You: " : ""}
                {preview}
              </span>
            )
          )}
        </span>
      </button>
    </li>
  );
}

export function ConversationList({ activeId, onSelect, onNew }: { activeId: string | null; onSelect: (id: string) => void; onNew: () => void }) {
  const conversations = useChatStore((s) => s.conversations);
  const load = useChatStore((s) => s.listLoad);
  const error = useChatStore((s) => s.listError);
  const query = useChatStore((s) => s.query);
  const [text, setText] = useState(query);

  // Debounced server-side search over titles, message text and file names.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (text.trim() !== useChatStore.getState().query) void useChatStore.getState().loadConversations(text.trim());
    }, 250);
    return () => clearTimeout(timer);
  }, [text]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 p-3">
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search conversations"
          aria-label="Search conversations"
          className="h-9 min-w-0 flex-1 rounded-lg bg-nx-bg/80 px-3 text-sm text-nx-text ring-1 ring-nx-line-strong placeholder:text-nx-faint focus:ring-nx-violet/60 focus:outline-none"
        />
        <button type="button" onClick={onNew} className="h-9 shrink-0 rounded-lg bg-nx-violet/30 px-3 text-sm font-semibold text-white ring-1 ring-nx-violet/60 hover:bg-nx-violet/40">
          New
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {load === "error" && (
          <p role="alert" className="px-3 text-sm text-nx-error">
            Couldn&apos;t load conversations ({error}).
          </p>
        )}
        {load === "loading" && <p className="px-3 text-sm text-nx-muted">Loading…</p>}
        {load === "ready" && conversations.length === 0 && (
          <p className="px-3 py-2 text-sm text-nx-muted">{query ? `Nothing matches “${query}”.` : "No conversations yet. Start one with New."}</p>
        )}
        <ul aria-label="Conversations" className="space-y-1">
          {conversations.map((c) => (
            <Row key={c.id} conversation={c} active={c.id === activeId} onSelect={() => onSelect(c.id)} />
          ))}
        </ul>
      </div>
    </div>
  );
}
