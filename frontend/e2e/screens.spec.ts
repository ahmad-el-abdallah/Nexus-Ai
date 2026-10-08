import { expect, test } from "@playwright/test";

import { collectErrors, waitForOffice } from "./helpers";

// Replies come from backend/tests/fake_provider.py; the real NVIDIA API is never called.
const REPLY = "Hello from the NEXUS test provider.";

interface DrawnScreen {
  desk: string;
  index: number;
  employeeId: string | null;
  app: string;
  mode: string;
  heading: string;
  status: string;
  body: string;
}

const screens = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as { __NEXUS_OFFICE__: { screens: () => DrawnScreen[] } }).__NEXUS_OFFICE__.screens());

test("desk monitors show each employee's real work in a role-styled app", async ({ page, request }) => {
  const errors = collectErrors(page);
  expect((await request.post("/api/ai/models/refresh")).ok()).toBe(true);
  await request.patch("/api/ai/settings", { data: { default_model: "fake/fast", paused: false } });
  const roster = await (await request.get("/api/employees")).json();
  const engineer = roster.find((e: { department: string; desk_id: string | null; seniority: string; status: string }) => e.department === "engineering" && e.desk_id && e.seniority !== "executive" && e.status !== "suspended");

  await page.goto("/");
  await waitForOffice(page);
  await expect.poll(async () => (await screens(page)).filter((s) => s.employeeId === engineer.id).length).toBeGreaterThan(0);
  const idle = (await screens(page)).find((s) => s.employeeId === engineer.id && s.index === 0)!;
  expect(idle).toMatchObject({ app: "code", mode: "idle", status: "Idle" });

  // A chat reply streams onto the engineer's monitor, in their code editor.
  const conversation = await (await request.post("/api/conversations", { data: { kind: "employee", employee_id: engineer.id } })).json();
  await request.post(`/api/conversations/${conversation.id}/messages`, { multipart: { content: "Sketch the notes API." } });
  await expect
    .poll(async () => (await screens(page)).find((s) => s.employeeId === engineer.id && s.index === 0), { timeout: 10_000 })
    .toMatchObject({ app: "code", mode: "work", heading: "Reply to the owner", status: "✓ Reply sent", body: expect.stringContaining(REPLY.slice(0, 20)) });
  // Dual-monitor desks show the message being answered on the second screen.
  const second = (await screens(page)).find((s) => s.employeeId === engineer.id && s.index === 1);
  if (second) expect(second).toMatchObject({ heading: "Owner's message", body: "Sketch the notes API." });

  // Free desks keep the lock screen; nothing is invented for them.
  expect((await screens(page)).filter((s) => s.employeeId === null).every((s) => s.mode === "lock")).toBe(true);

  // "View screen" looks over their shoulder.
  await page.evaluate((id) => (window as unknown as { __NEXUS_OFFICE__: { actions: { selectEmployee: (id: string) => void } } }).__NEXUS_OFFICE__.actions.selectEmployee(id), engineer.id);
  await page.getByTestId("employee-panel").getByRole("button", { name: "View screen" }).click();
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __NEXUS_OFFICE__: { camera: () => { zoom: number; overviewZoom: number } } }).__NEXUS_OFFICE__.camera())).zoom, { timeout: 10_000 }).toBeGreaterThan(100);
  expect(errors).toEqual([]);
});
