import { create } from "zustand";

import {
  type Conversation,
  createConversation,
  deleteConversation,
  fetchConversation,
  fetchConversations,
  fetchMessages,
  type Message,
  type ReplyState,
  renameConversation,
  retryReply,
  sendMessage,
  stopReply,
  type Target,
} from "@/lib/chat";
import { liveEvents } from "@/lib/events";

type LoadState = "idle" | "loading" | "ready" | "error";

export interface ChatState {
  conversations: Conversation[];
  listLoad: LoadState;
  listError: string | null;
  query: string;
  messages: Record<string, Message[]>;
  messageLoad: Record<string, LoadState>;
  messageError: Record<string, string>;
  /** Live progress of replies being written, by conversation. */
  replies: Record<string, { messageId: number; state: ReplyState }>;
  /** When live data last arrived for a conversation (ms epoch). */
  touched: Record<string, number>;
  loadConversations: (query?: string) => Promise<void>;
  loadMessages: (conversationId: string) => Promise<void>;
  /** Makes sure one conversation is in the list (e.g. opened by link); false if it doesn't exist. */
  ensureConversation: (conversationId: string) => Promise<boolean>;
  /** Sends to an existing conversation, or starts one for `target`. Returns the conversation id. */
  send: (to: { conversationId: string } | { target: Target }, text: string, files?: File[]) => Promise<string>;
  stop: (conversationId: string) => Promise<void>;
  retry: (conversationId: string) => Promise<void>;
  rename: (conversationId: string, title: string) => Promise<void>;
  remove: (conversationId: string) => Promise<void>;
  // Live event reducers (exported for tests).
  applyConversation: (conversation: Conversation) => void;
  applyConversationDeleted: (id: string) => void;
  applyMessage: (message: Message) => void;
  applyToken: (token: { conversation_id: string; message_id: number; at: number; text: string }) => void;
  applyReplyState: (event: { conversation_id: string; message_id: number; state: ReplyState }) => void;
}

const activity = (c: Conversation) => c.last_message_at ?? c.created_at;
const byActivity = (a: Conversation, b: Conversation) => activity(b).localeCompare(activity(a));

/** Merges a message into a list ordered by id. Streaming content never shrinks. */
function mergeMessage(list: Message[], message: Message): Message[] {
  const index = list.findIndex((m) => m.id === message.id);
  if (index === -1) return [...list, message].sort((a, b) => a.id - b.id);
  const current = list[index];
  const keep = message.status === "streaming" && current.status === "streaming" && current.content.length > message.content.length;
  const next = [...list];
  next[index] = keep ? { ...message, content: current.content } : message;
  return next;
}

const refetching = new Set<string>();

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  listLoad: "idle",
  listError: null,
  query: "",
  messages: {},
  messageLoad: {},
  messageError: {},
  replies: {},
  touched: {},

  loadConversations: async (query = get().query) => {
    set({ query, listLoad: get().listLoad === "ready" ? "ready" : "loading" });
    try {
      const conversations = await fetchConversations({ q: query || undefined });
      if (get().query !== query) return; // a newer search is in flight
      set({ conversations, listLoad: "ready", listError: null });
    } catch (error) {
      set({ listLoad: "error", listError: (error as Error).message });
    }
  },

  loadMessages: async (conversationId) => {
    if (!get().messages[conversationId]) set({ messageLoad: { ...get().messageLoad, [conversationId]: "loading" } });
    try {
      const messages = await fetchMessages(conversationId);
      // Keep text that streamed in while the request was in flight.
      const local = new Map((get().messages[conversationId] ?? []).map((m) => [m.id, m]));
      const merged = messages.map((m) => {
        const l = local.get(m.id);
        return l && l.status === "streaming" && m.status === "streaming" && l.content.length > m.content.length ? { ...m, content: l.content } : m;
      });
      // A reply that is no longer streaming can't still be in progress.
      const replies = { ...get().replies };
      if (!merged.some((m) => m.status === "streaming")) delete replies[conversationId];
      set({
        replies,
        messages: { ...get().messages, [conversationId]: merged },
        messageLoad: { ...get().messageLoad, [conversationId]: "ready" },
        messageError: { ...get().messageError, [conversationId]: "" },
      });
    } catch (error) {
      set({
        messageLoad: { ...get().messageLoad, [conversationId]: "error" },
        messageError: { ...get().messageError, [conversationId]: (error as Error).message },
      });
    }
  },

  ensureConversation: async (conversationId) => {
    if (get().conversations.some((c) => c.id === conversationId)) return true;
    try {
      const conversation = await fetchConversation(conversationId);
      if (!get().conversations.some((c) => c.id === conversationId))
        set({ conversations: [...get().conversations, conversation].sort(byActivity) });
      return true;
    } catch {
      return false;
    }
  },

  send: async (to, text, files = []) => {
    let conversationId: string;
    if ("target" in to) {
      const conversation = await createConversation(to.target);
      get().applyConversation(conversation);
      set({
        messages: { ...get().messages, [conversation.id]: [] },
        messageLoad: { ...get().messageLoad, [conversation.id]: "ready" },
      });
      conversationId = conversation.id;
    } else {
      conversationId = to.conversationId;
    }
    const { message, reply } = await sendMessage(conversationId, text, files);
    get().applyMessage(message);
    if (reply) get().applyMessage(reply);
    return conversationId;
  },

  stop: async (conversationId) => {
    await stopReply(conversationId);
  },

  retry: async (conversationId) => {
    get().applyMessage(await retryReply(conversationId));
  },

  rename: async (conversationId, title) => {
    get().applyConversation(await renameConversation(conversationId, title));
  },

  remove: async (conversationId) => {
    await deleteConversation(conversationId);
    get().applyConversationDeleted(conversationId);
  },

  applyConversation: (conversation) => {
    const list = get().conversations;
    const exists = list.some((c) => c.id === conversation.id);
    // While searching, only refresh rows that already match.
    if (!exists && get().query) return;
    const next = exists ? list.map((c) => (c.id === conversation.id ? { ...conversation, match: c.match } : c)) : [conversation, ...list];
    set({ conversations: next.sort(byActivity) });
  },

  applyConversationDeleted: (id) => {
    const messages = { ...get().messages };
    delete messages[id];
    const replies = { ...get().replies };
    delete replies[id];
    set({ conversations: get().conversations.filter((c) => c.id !== id), messages, replies });
  },

  applyMessage: (message) => {
    const list = get().messages[message.conversation_id];
    if (!list) return; // not open in this tab
    set({
      messages: { ...get().messages, [message.conversation_id]: mergeMessage(list, message) },
      touched: { ...get().touched, [message.conversation_id]: Date.now() },
    });
  },

  applyToken: ({ conversation_id, message_id, at, text }) => {
    const list = get().messages[conversation_id];
    const message = list?.find((m) => m.id === message_id);
    if (!list || !message) {
      if (list && !refetching.has(conversation_id)) {
        refetching.add(conversation_id);
        void get().loadMessages(conversation_id).finally(() => refetching.delete(conversation_id));
      }
      return;
    }
    const length = message.content.length;
    if (at > length) {
      // Missed part of the stream: the backend has the full text so far.
      if (!refetching.has(conversation_id)) {
        refetching.add(conversation_id);
        void get().loadMessages(conversation_id).finally(() => refetching.delete(conversation_id));
      }
      return;
    }
    const end = at + text.length;
    if (end <= length) return; // already have it
    const content = message.content + text.slice(length - at);
    set({
      messages: { ...get().messages, [conversation_id]: list.map((m) => (m.id === message_id ? { ...m, content } : m)) },
      touched: { ...get().touched, [conversation_id]: Date.now() },
    });
  },

  applyReplyState: ({ conversation_id, message_id, state }) => {
    const replies = { ...get().replies };
    if (state === "done") delete replies[conversation_id];
    else replies[conversation_id] = { messageId: message_id, state };
    set({ replies, touched: { ...get().touched, [conversation_id]: Date.now() } });
  },
}));

export const STALE_STREAM_MS = 4_000;

/**
 * Safety net for live updates that don't arrive (a buffering proxy, a dropped
 * connection): while a reply in an open conversation is streaming and nothing has
 * arrived for a while, reload it from the backend, which always has the text so far.
 */
export function refreshStaleStreams(now = Date.now()) {
  const s = useChatStore.getState();
  for (const [id, list] of Object.entries(s.messages)) {
    if (!list.some((m) => m.status === "streaming")) continue;
    if (now - (s.touched[id] ?? 0) < STALE_STREAM_MS) continue;
    useChatStore.setState({ touched: { ...useChatStore.getState().touched, [id]: now } });
    void s.loadMessages(id);
  }
}

/** Subscribes the chat store to live events; returns a stop function. */
export function startChatSync(): () => void {
  const store = useChatStore.getState;
  const release = liveEvents.retain();
  const off = [
    liveEvents.on("conversation.updated", (d) => store().applyConversation(d as Conversation)),
    liveEvents.on("conversation.deleted", (d) => store().applyConversationDeleted((d as { id: string }).id)),
    liveEvents.on("message.created", (d) => store().applyMessage(d as Message)),
    liveEvents.on("message.updated", (d) => store().applyMessage(d as Message)),
    liveEvents.on("message.token", (d) => store().applyToken(d as Parameters<ChatState["applyToken"]>[0])),
    liveEvents.on("reply.state", (d) => store().applyReplyState(d as Parameters<ChatState["applyReplyState"]>[0])),
    liveEvents.onStatus((_status, reconnected) => {
      if (!reconnected) return;
      // Anything could have happened while disconnected: reload what is on screen.
      useChatStore.setState({ replies: {} });
      void store().loadConversations();
      for (const id of Object.keys(store().messages)) void store().loadMessages(id);
    }),
  ];
  const timer = setInterval(() => refreshStaleStreams(), 2_000);
  return () => {
    clearInterval(timer);
    off.forEach((f) => f());
    release();
  };
}
