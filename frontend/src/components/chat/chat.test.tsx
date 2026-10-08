import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Conversation, Message } from "@/lib/chat";
import type { Department } from "@/lib/departments";
import type { Employee } from "@/lib/employees";
import { refreshStaleStreams, useChatStore } from "@/world/state/chatStore";
import { useDepartmentStore } from "@/world/state/departmentStore";
import { useEmployeeStore } from "@/world/state/employeeStore";

import { ConversationView } from "./ConversationView";
import { TaskDialog } from "./TaskDialog";

const initialChat = useChatStore.getState();

const cmo: Employee = {
  id: "emp_cmo",
  name: "Elena Rossi",
  role: "Chief Marketing Officer",
  department: "marketing",
  seniority: "executive",
  desk_id: "marketing-desk-1",
  supervisor_id: null,
  avatar_seed: 301,
  status: "idle",
  status_detail: null,
  status_changed_at: "2026-10-08T09:00:00Z",
};
const marketing = { key: "marketing", name: "Marketing", director_id: "emp_cmo", color: "#f472b6", roles: [], responsibilities: [] } as unknown as Department;

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: "cnv_1",
  kind: "department",
  department: "marketing",
  employee_id: null,
  title: "Launch plan",
  created_at: "2026-10-08T09:00:00Z",
  last_message_at: "2026-10-08T09:01:00Z",
  message_count: 0,
  last_message: null,
  replying: false,
  match: null,
  ...over,
});

const message = (over: Partial<Message> = {}): Message => ({
  id: 1,
  conversation_id: "cnv_1",
  created_at: "2026-10-08T09:00:00Z",
  role: "agent",
  employee_id: "emp_cmo",
  author_name: "Elena Rossi",
  author_role: "Chief Marketing Officer",
  author_department: "marketing",
  content: "",
  status: "complete",
  error: null,
  error_kind: null,
  model: null,
  model_source: null,
  prompt_tokens: null,
  completion_tokens: null,
  reasoning_tokens: null,
  first_token_ms: null,
  latency_ms: null,
  context_messages: null,
  finished_at: null,
  attachments: [],
  ...over,
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  useChatStore.setState(initialChat, true);
  useEmployeeStore.setState({ employees: [cmo], load: "ready" });
  useDepartmentStore.setState({ departments: [marketing], load: "ready" });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
});

describe("chat store live updates", () => {
  const open = (messages: Message[]) => useChatStore.setState({ messages: { cnv_1: messages }, messageLoad: { cnv_1: "ready" } });

  it("appends streamed tokens in order and ignores duplicates", () => {
    open([message({ id: 2, status: "streaming" })]);
    const s = useChatStore.getState();
    s.applyToken({ conversation_id: "cnv_1", message_id: 2, at: 0, text: "Hello" });
    s.applyToken({ conversation_id: "cnv_1", message_id: 2, at: 5, text: " world" });
    s.applyToken({ conversation_id: "cnv_1", message_id: 2, at: 0, text: "Hello" }); // replayed
    s.applyToken({ conversation_id: "cnv_1", message_id: 2, at: 3, text: "lo wor" }); // overlapping
    expect(useChatStore.getState().messages.cnv_1[0].content).toBe("Hello world");
  });

  it("reloads the conversation when part of the stream was missed", async () => {
    const fetchMock = vi.fn(async () => json([message({ id: 2, status: "streaming", content: "Hello world, again" })]));
    vi.stubGlobal("fetch", fetchMock);
    open([message({ id: 2, status: "streaming", content: "Hel" })]);
    useChatStore.getState().applyToken({ conversation_id: "cnv_1", message_id: 2, at: 11, text: ", again" });
    await waitFor(() => expect(useChatStore.getState().messages.cnv_1[0].content).toBe("Hello world, again"));
    expect(fetchMock).toHaveBeenCalledWith("/api/conversations/cnv_1/messages", expect.anything());
  });

  it("never shrinks a streaming message and takes the final text when done", () => {
    open([message({ id: 2, status: "streaming", content: "Hello wor" })]);
    const s = useChatStore.getState();
    s.applyMessage(message({ id: 2, status: "streaming", content: "Hel" }));
    expect(useChatStore.getState().messages.cnv_1[0].content).toBe("Hello wor");
    s.applyMessage(message({ id: 2, status: "complete", content: "Hello world" }));
    expect(useChatStore.getState().messages.cnv_1[0]).toMatchObject({ status: "complete", content: "Hello world" });
  });

  it("keeps the list ordered by activity and respects an active search", () => {
    const s = useChatStore.getState();
    s.applyConversation(conversation({ id: "a", last_message_at: "2026-10-08T09:00:00Z" }));
    s.applyConversation(conversation({ id: "b", last_message_at: "2026-10-08T10:00:00Z" }));
    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(["b", "a"]);
    s.applyConversation(conversation({ id: "a", last_message_at: "2026-10-08T11:00:00Z" }));
    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(["a", "b"]);
    useChatStore.setState({ query: "launch" });
    s.applyConversation(conversation({ id: "c" }));
    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(["a", "b"]);
    s.applyConversationDeleted("a");
    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(["b"]);
  });

  it("reloads a streaming reply when live updates stop arriving", async () => {
    const fetchMock = vi.fn(async () => json([message({ id: 2, status: "complete", content: "Done" })]));
    vi.stubGlobal("fetch", fetchMock);
    open([message({ id: 2, status: "streaming" })]);
    useChatStore.setState({ touched: { cnv_1: 1_000 }, replies: { cnv_1: { messageId: 2, state: "queued" } } });
    refreshStaleStreams(2_000); // recent activity: leave it alone
    expect(fetchMock).not.toHaveBeenCalled();
    refreshStaleStreams(10_000);
    await waitFor(() => expect(useChatStore.getState().messages.cnv_1[0].status).toBe("complete"));
    expect(useChatStore.getState().replies.cnv_1).toBeUndefined();
  });

  it("tracks reply progress until done", () => {
    const s = useChatStore.getState();
    s.applyReplyState({ conversation_id: "cnv_1", message_id: 2, state: "thinking" });
    expect(useChatStore.getState().replies.cnv_1).toEqual({ messageId: 2, state: "thinking" });
    s.applyReplyState({ conversation_id: "cnv_1", message_id: 2, state: "done" });
    expect(useChatStore.getState().replies.cnv_1).toBeUndefined();
  });
});

describe("ConversationView", () => {
  const view = (c: Conversation | null = conversation()) =>
    render(<ConversationView conversation={c} target={{ kind: "department", department: "marketing" }} onCreated={() => {}} onDeleted={() => {}} onBack={() => {}} highlightMessage={null} />);

  it("renders Markdown safely with author, model and real measurements", () => {
    useChatStore.setState({
      messages: {
        cnv_1: [
          message({ id: 1, role: "owner", employee_id: null, author_name: null, content: "Plan **Q4** <img src=x onerror=alert(1)>" }),
          message({ id: 2, content: "## Plan\n- one\n- two", model: "acme/fast", prompt_tokens: 20, completion_tokens: 4, first_token_ms: 300, latency_ms: 1200, context_messages: 1 }),
        ],
      },
      messageLoad: { cnv_1: "ready" },
    });
    const { container } = view();
    const items = screen.getAllByTestId("message");
    expect(items[0].querySelector("strong")).toHaveTextContent("Q4");
    expect(container.querySelector("img")).toBeNull();
    expect(within(items[1]).getByRole("heading", { name: "Plan" })).toBeInTheDocument();
    expect(items[1]).toHaveTextContent("Elena Rossi · Chief Marketing Officer · Marketing");
    expect(items[1]).toHaveTextContent("acme/fast · 20 in / 4 out tokens · first token 300 ms · total 1.2 s · context: 1 message");
    expect(screen.getByText(/Answered by Elena Rossi, director/)).toBeInTheDocument();
  });

  it("shows honest reply progress and a stop button while streaming", () => {
    useChatStore.setState({
      messages: { cnv_1: [message({ id: 1, role: "owner", content: "hi" }), message({ id: 2, status: "streaming" })] },
      messageLoad: { cnv_1: "ready" },
      replies: { cnv_1: { messageId: 2, state: "thinking" } },
    });
    view();
    expect(screen.getByRole("status")).toHaveTextContent("Thinking — the model is reasoning (its reasoning isn't shown)");
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("explains failed replies and offers a retry", async () => {
    const fetchMock = vi.fn(async () => json(message({ id: 3, status: "streaming" }), 201));
    vi.stubGlobal("fetch", fetchMock);
    useChatStore.setState({
      messages: { cnv_1: [message({ id: 1, role: "owner", content: "hi" }), message({ id: 2, status: "error", error: "AI requests are paused by the emergency stop.", error_kind: "paused" })] },
      messageLoad: { cnv_1: "ready" },
    });
    view();
    expect(screen.getByRole("alert")).toHaveTextContent("No reply. AI requests are paused by the emergency stop.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/conversations/cnv_1/reply", expect.objectContaining({ method: "POST" })));
  });

  it("replaces the composer when nobody can answer", () => {
    useEmployeeStore.setState({ employees: [{ ...cmo, status: "suspended" }] });
    useChatStore.setState({ messages: { cnv_1: [] }, messageLoad: { cnv_1: "ready" } });
    view();
    expect(screen.getByText(/Marketing has no available employee to reply/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  });

  it("starts a new conversation on first send, as multipart with files", async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push([url, init]);
        if (url === "/api/conversations") return json(conversation({ id: "cnv_new", title: "New conversation" }), 201);
        return json({ message: message({ id: 1, conversation_id: "cnv_new", role: "owner", content: "Hello" }), reply: message({ id: 2, conversation_id: "cnv_new", status: "streaming" }) }, 201);
      }),
    );
    const onCreated = vi.fn();
    render(<ConversationView conversation={null} target={{ kind: "department", department: "marketing" }} onCreated={onCreated} onDeleted={() => {}} onBack={() => {}} highlightMessage={null} />);
    expect(screen.getByTestId("conversation-title")).toHaveTextContent("New conversation with Marketing department");
    const file = new File(["# notes"], "notes.md", { type: "text/markdown" });
    fireEvent.change(screen.getByTestId("file-input"), { target: { files: [file] } });
    expect(screen.getByRole("list", { name: "Files to send" })).toHaveTextContent("notes.md");
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Hello" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("cnv_new"));
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ kind: "department", department: "marketing" });
    const form = calls[1][1].body as FormData;
    expect(calls[1][0]).toBe("/api/conversations/cnv_new/messages");
    expect(form.get("content")).toBe("Hello");
    expect((form.get("files") as File).name).toBe("notes.md");
    expect(new Headers(calls[1][1].headers).get("content-type")).toBeNull();
    expect(useChatStore.getState().messages.cnv_new.map((m) => m.id)).toEqual([1, 2]);
  });

  it("rejects oversized attachments before uploading", () => {
    view();
    const big = new File(["x"], "big.bin");
    Object.defineProperty(big, "size", { value: 3 * 1024 * 1024 });
    fireEvent.change(screen.getByTestId("file-input"), { target: { files: [big] } });
    expect(screen.getByRole("alert")).toHaveTextContent("“big.bin” is larger than 2.0 MB.");
  });
});

describe("TaskDialog", () => {
  it("records a task and says it won't run before Stage 8", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return json({ id: "tsk_1", status: "open", created_at: "", updated_at: "", source_message_id: 2, ...body }, 201);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskDialog source={{ text: "## Launch the campaign\nDetails here", department: "marketing", assigneeId: "emp_cmo", conversationId: "cnv_1", messageId: 2 }} onClose={() => {}} />);
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Launch the campaign");
    expect(screen.getByRole("combobox", { name: "Assignee" })).toHaveValue("emp_cmo");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByText(/open — not started/)).toBeInTheDocument();
    expect(screen.getByText(/orchestration engine arrives in Stage 8/)).toBeInTheDocument();
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent).toMatchObject({ title: "Launch the campaign", department: "marketing", assignee_id: "emp_cmo", source_conversation_id: "cnv_1", source_message_id: 2 });
  });
});
