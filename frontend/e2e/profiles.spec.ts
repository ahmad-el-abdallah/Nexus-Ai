import { expect, test } from "@playwright/test";

import { collectErrors } from "./helpers";

test.describe("Employee profiles & ratings", () => {
  test("a profile opens from the roster, shows honest metrics, and the owner's changes persist", async ({ page, request }) => {
    const errors = collectErrors(page);
    const roster = await (await request.get("/api/employees")).json();
    const priya = roster.find((e: { name: string }) => e.name === "Priya Nair");

    await page.goto("/departments/sales");
    await page.getByTestId("team-table").getByRole("link", { name: "Priya Nair" }).click();
    await expect(page).toHaveURL(new RegExp(`/employees/${priya.id}`));
    await expect(page.getByRole("heading", { name: "Priya Nair" })).toBeVisible();

    // No activity yet: a real "not enough data" message, never a fabricated score.
    const perf = page.getByRole("region", { name: "Performance" });
    await expect(perf).toContainText("Not enough data");
    await expect(perf).not.toContainText("%");

    // Skills the owner adds persist across a reload.
    const skills = page.getByRole("region", { name: "Skills" });
    await skills.getByLabel("Add a skill").fill("Prospecting");
    await skills.getByRole("button", { name: "Add" }).click();
    await expect(skills.getByRole("list", { name: "Skills" })).toContainText("Prospecting");

    // A rating is saved and shown in the feedback history.
    const rating = page.getByRole("region", { name: "Owner rating & feedback" });
    await rating.getByRole("radio", { name: "5 stars" }).click();
    await rating.getByLabel("Feedback note").fill("Reliable follow-up");
    await rating.getByRole("button", { name: "Add feedback" }).click();
    await expect(rating.getByRole("list", { name: "Feedback history" })).toContainText("Reliable follow-up");

    await page.reload();
    await expect(page.getByRole("region", { name: "Skills" }).getByRole("list", { name: "Skills" })).toContainText("Prospecting");
    await expect(page.getByRole("region", { name: "Owner rating & feedback" })).toContainText("5");
    // The rating is reflected in the API, computed from stored feedback only.
    const profile = await (await request.get(`/api/employees/${priya.id}/profile`)).json();
    expect(profile.rating).toEqual({ average: 5, count: 1 });
    expect(profile.skills).toContain("Prospecting");
    expect(profile.history.some((h: { kind: string }) => h.kind === "rated")).toBe(true);
    expect(errors).toEqual([]);
  });
});
