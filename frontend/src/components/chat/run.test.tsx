import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CodeRun } from "@/lib/runs";

import { Markdown } from "./Markdown";
import { RunDialog } from "./RunDialog";

const CODE = "print('hello')";

const run = (over: Partial<CodeRun> = {}): CodeRun => ({
  id: "run_1",
  language: "python",
  code: CODE,
  code_sha256: "a".repeat(64),
  status: "pending_approval",
  message_id: 7,
  task_id: null,
  employee_id: "e1",
  author_name: "Sameer Abuhummus",
  exit_code: null,
  duration_ms: null,
  stdout: "",
  stderr: "",
  files: [],
  error: null,
  created_at: null,
  approved_at: null,
  finished_at: null,
  ...over,
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("code blocks", () => {
  it("offer Copy, Download and Run for runnable code", () => {
    const onRun = vi.fn();
    render(<Markdown text={"Script:\n\n```python\nprint('hello')\n```\n\n```json\n{\"a\": 1}\n```"} onRun={onRun} />);
    const [python, data] = screen.getAllByTestId("code-block");
    expect(within(python).getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(within(python).getByRole("button", { name: "Download" })).toBeInTheDocument();
    fireEvent.click(within(python).getByRole("button", { name: "▶ Run" }));
    expect(onRun).toHaveBeenCalledWith(CODE, "python");
    expect(within(data).queryByRole("button", { name: "▶ Run" })).toBeNull(); // JSON isn't a program
    expect(within(data).getByRole("button", { name: "Download" })).toBeInTheDocument();
  });

  it("can't be run while the reply is still being written", () => {
    render(<Markdown text={"```python\nprint(1)\n```"} streaming onRun={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "▶ Run" })).toBeNull();
  });
});

describe("RunDialog", () => {
  it("shows the exact code and runs it only after approval", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push([url, init]);
        if (url === "/api/runs") return json(run(), 201);
        if (url.endsWith("/approve")) return json(run({ status: "succeeded", exit_code: 0, duration_ms: 420, stdout: "hello\n", files: [{ name: "report.csv", size: 26 }] }));
        return json(run());
      }),
    );
    render(<RunDialog request={{ code: CODE, language: "python", messageId: 7 }} onClose={() => {}} />);
    expect(await screen.findByText(/Written by Sameer Abuhummus/)).toBeInTheDocument();
    expect(screen.getByTestId("run-code")).toHaveTextContent(CODE);
    expect(screen.getByRole("list", { name: "Sandbox rules" })).toHaveTextContent("No internet access");
    expect(calls.some(([url]) => url.endsWith("/approve"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Approve and run" }));
    const result = await screen.findByTestId("run-result");
    expect(result).toHaveTextContent("Finished · exit code 0 · 420 ms");
    expect(screen.getByTestId("run-stdout")).toHaveTextContent("hello");
    expect(screen.getByRole("link", { name: /report\.csv/ })).toHaveAttribute("href", "/api/runs/run_1/files/report.csv");
    const approve = calls.find(([url]) => url.endsWith("/approve"))!;
    expect(JSON.parse(approve[1]!.body as string)).toEqual({ code_sha256: "a".repeat(64) });
    const prepare = calls.find(([url]) => url === "/api/runs")!;
    expect(JSON.parse(prepare[1]!.body as string)).toMatchObject({ code: CODE, language: "python", message_id: 7 });
  });

  it("declining doesn't run anything", async () => {
    const fetchMock = vi.fn(async (url: string) => (url === "/api/runs" ? json(run(), 201) : json(run({ status: "rejected" }))));
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    render(<RunDialog request={{ code: CODE, language: "python", messageId: 7 }} onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Don't run" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/reject"))).toBe(true));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/approve"))).toBe(false);
    expect(onClose).toHaveBeenCalled();
  });

  it("explains when the sandbox refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "The code doesn't match what the employee wrote." }, 422)));
    render(<RunDialog request={{ code: CODE, language: "python", messageId: 7 }} onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("doesn't match");
    expect(screen.queryByRole("button", { name: "Approve and run" })).toBeNull();
  });
});
