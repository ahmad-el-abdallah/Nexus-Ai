import { expect, test } from "@playwright/test";

import { collectErrors } from "./helpers";

// The e2e backend runs stand-in speech engines (NEXUS_VOICE_FAKE, test-only) and
// Chrome a fake microphone (a tone), so recordings always "say" this sentence.
const TRANSCRIPT = "This is a voice test for the marketing team.";
const REPLY = "Hello from the NEXUS test provider.";

test.describe("Voice communication", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ request }) => {
    expect((await request.post("/api/ai/models/refresh")).ok()).toBe(true);
    expect((await request.patch("/api/ai/settings", { data: { default_model: "fake/fast", paused: false } })).ok()).toBe(true);
    expect((await request.patch("/api/voice/settings", { data: { muted: false, speak_replies: false, language: "auto" } })).ok()).toBe(true);
  });

  test("Settings → Voice lists the local models and the microphone test transcribes", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/settings/voice");
    await expect(page.getByRole("heading", { name: "Speech recognition (speech → text)" })).toBeVisible();
    for (const id of ["whisper-base", "whisper-small", "piper-en_US-libritts_r-medium", "piper-ar_JO-kareem-medium"]) {
      await expect(page.locator(`li[data-model="${id}"]`)).toContainText("Installed");
    }
    await page.getByRole("button", { name: "Record a test" }).click();
    const stop = page.getByRole("button", { name: /Stop & transcribe/ });
    await expect(stop).toBeVisible();
    await page.waitForTimeout(1200);
    await stop.click();
    await expect(page.getByTestId("mic-test-result")).toContainText(TRANSCRIPT);
    await expect(page.getByTestId("mic-test-result")).toContainText("whisper-base");
    expect(errors).toEqual([]);
  });

  test("a voice message is transcribed for review, sent with its recording, and answered by the right employee", async ({ page }) => {
    await page.goto("/chat?to=department:marketing");
    await page.getByRole("button", { name: "Record a voice message" }).click();
    const stop = page.getByRole("button", { name: "Stop recording and transcribe" });
    await expect(stop).toBeVisible();
    await page.waitForTimeout(1200);
    await stop.click();
    const box = page.getByRole("textbox", { name: "Message" });
    await expect(box).toHaveValue(TRANSCRIPT);
    await expect(page.getByTestId("voice-draft")).toContainText("Voice message");

    // The owner reviews (and may edit) the transcript before sending.
    await box.fill(`${TRANSCRIPT} Please reply briefly.`);
    await page.getByRole("button", { name: "Send" }).click();
    const owner = page.locator('[data-testid="message"][data-role="owner"]').last();
    await expect(owner.getByTestId("voice-badge")).toBeVisible();
    await expect(owner).toContainText("Please reply briefly.");
    await expect(owner.locator("audio")).toHaveAttribute("src", /\/api\/attachments\/att_[0-9a-f]+\?play=1/);
    const reply = page.locator('[data-testid="message"][data-role="agent"]').last();
    await expect(reply).toContainText("Elena Rossi · Chief Marketing Officer · Marketing");
    await expect(reply).toContainText(REPLY);
    await expect(page.getByTestId("voice-draft")).toHaveCount(0);

    // Replies can be listened to (synthesised locally).
    const speak = page.waitForResponse((r) => r.url().endsWith("/api/voice/speak") && r.status() === 200);
    await reply.getByRole("button", { name: "Listen to this reply" }).click();
    expect((await speak).headers()["content-type"]).toBe("audio/wav");
  });

  test("a hands-free voice session reads the reply aloud, listens again and sends after a countdown", async ({ page }) => {
    await page.goto("/chat?to=department:marketing");
    await page.getByRole("button", { name: "Start voice session" }).click();
    const session = page.getByTestId("voice-session");
    await expect(session).toContainText("Ready");

    await session.getByRole("button", { name: "Talk" }).click();
    await expect(session).toContainText("Listening…");
    await page.waitForTimeout(1200);
    await session.getByRole("button", { name: "Done talking" }).click();
    await expect(session).toContainText(/Sending in \d/);
    // The countdown sends it without another click.
    const owner = page.locator('[data-testid="message"][data-role="owner"]').last();
    await expect(owner).toContainText(TRANSCRIPT, { timeout: 8_000 });

    // The reply is spoken, then the session listens again by itself.
    const speak = page.waitForResponse((r) => r.url().endsWith("/api/voice/speak"));
    await expect(page.locator('[data-testid="message"][data-role="agent"]').last()).toContainText(REPLY);
    expect((await speak).status()).toBe(200);
    await expect(session).toContainText("Listening…", { timeout: 10_000 });

    // Editing the transcript cancels the automatic send.
    await page.waitForTimeout(1000);
    await session.getByRole("button", { name: "Done talking" }).click();
    await expect(session).toContainText(/Sending in \d/);
    await page.getByRole("textbox", { name: "Message" }).fill("Actually, wait.");
    await expect(session).not.toContainText("Sending in");
    await page.waitForTimeout(3500);
    await expect(page.locator('[data-testid="message"][data-role="owner"]')).toHaveCount(1);

    await session.getByRole("button", { name: "Mute mic" }).click();
    await expect(session).toContainText("Microphone muted");
    await session.getByRole("button", { name: "End" }).click();
    await expect(page.getByTestId("voice-session")).toHaveCount(0);
  });

  test("a blocked microphone is explained and typing still works", async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    });
    const errors = collectErrors(page);
    await page.goto("/chat?to=department:engineering");
    await page.getByRole("button", { name: "Record a voice message" }).click();
    await expect(page.getByTestId("voice-notice")).toContainText("Microphone access is blocked");
    await page.getByRole("textbox", { name: "Message" }).fill("Typing still works");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator('[data-testid="message"][data-role="agent"]').last()).toContainText(REPLY);
    expect(errors).toEqual([]);
  });

  test("Arabic is accepted and shown right-to-left", async ({ page, request }) => {
    expect((await request.patch("/api/voice/settings", { data: { language: "ar" } })).ok()).toBe(true);
    await page.goto("/chat?to=department:marketing");
    await page.getByRole("button", { name: "Record a voice message" }).click();
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Stop recording and transcribe" }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("هذا اختبار صوتي لفريق التسويق.");
    await page.getByRole("button", { name: "Send" }).click();
    const owner = page.locator('[data-testid="message"][data-role="owner"]').last();
    await expect(owner.locator('[dir="auto"]').first()).toContainText("هذا اختبار صوتي");
    await request.patch("/api/voice/settings", { data: { language: "auto" } });
  });
});
