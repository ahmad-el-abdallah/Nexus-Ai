import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3200);
const API_PORT = Number(process.env.E2E_API_PORT ?? 18200);
const DB = `/tmp/nexus-e2e-${API_PORT}.db`;
const FAKE_AI_PORT = Number(process.env.E2E_FAKE_AI_PORT ?? 18300);
// Matches backend/tests/fake_provider.py — e2e never calls the real NVIDIA API.
const FAKE_AI_KEY = "fake-e2e-key-0123456789abcdef";
// backend/tests/fake_mail.py: SMTP + IMAP on 127.0.0.1 and a control port (no real mail).
const FAKE_MAIL = { smtp: 18325, imap: 18326, control: 18327 };
// Test-only Fernet key so stored mail credentials don't depend on backend/.env.
const E2E_SECRET_KEY = "ZTJlLXRlc3Qta2V5LW5vdC1hLXJlYWwtc2VjcmV0ISE=";
// Render with the machine's GPU through ANGLE/OpenGL; headless Chrome would
// otherwise use the much slower SwiftShader software renderer.
const GPU_ARGS = process.env.E2E_SOFTWARE_GL ? [] : ["--use-angle=gl", "--enable-gpu", "--ignore-gpu-blocklist"];
// A fake microphone (a tone) with permission granted, so voice recording can run headless.
const MIC_ARGS = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"];

/**
 * End-to-end tests run against a production build in the locally installed
 * Google Chrome (no browser download needed).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../.artifacts/e2e",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: "chrome",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { viewport: { width: 1440, height: 900 }, launchOptions: { args: [...GPU_ARGS, ...MIC_ARGS] } },
      testIgnore: /(mobile|no-webgl)\.spec/,
    },
    { name: "mobile", use: { ...devices["Pixel 7"], channel: "chrome", launchOptions: { args: GPU_ARGS } }, testMatch: /mobile\.spec/ },
    {
      name: "no-webgl",
      use: { viewport: { width: 1280, height: 800 }, launchOptions: { args: ["--disable-webgl", "--disable-3d-apis"] } },
      testMatch: /no-webgl\.spec/,
    },
  ],
  webServer: [
    {
      command: `uv run --frozen python -m tests.fake_mail --smtp-port ${FAKE_MAIL.smtp} --imap-port ${FAKE_MAIL.imap} --control-port ${FAKE_MAIL.control}`,
      cwd: "../backend",
      url: `http://127.0.0.1:${FAKE_MAIL.control}/`,
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      command: `uv run --frozen uvicorn tests.fake_provider:app --host 127.0.0.1 --port ${FAKE_AI_PORT}`,
      cwd: "../backend",
      url: `http://127.0.0.1:${FAKE_AI_PORT}/docs`,
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      // Isolated backend with a fresh, migrated throwaway database.
      command: `rm -f ${DB}* && uv run --frozen alembic upgrade head && uv run --frozen python -m app`,
      cwd: "../backend",
      env: {
        NEXUS_DATABASE_URL: `sqlite+aiosqlite:///${DB}`,
        NEXUS_PORT: String(API_PORT),
        NEXUS_ENV: "test",
        NEXUS_LOG_LEVEL: "WARNING",
        NVIDIA_API_KEY: FAKE_AI_KEY,
        NVIDIA_BASE_URL: `http://127.0.0.1:${FAKE_AI_PORT}/v1`,
        // Stand-in speech engines (allowed only with NEXUS_ENV=test): no 300 MB model downloads.
        NEXUS_VOICE_FAKE: "1",
        NEXUS_VOICE_DIR: `/tmp/nexus-e2e-voice-${API_PORT}`,
        NEXUS_SECRET_KEY: E2E_SECRET_KEY,
        NEXUS_PUBLIC_URL: `http://127.0.0.1:${PORT}`,
        // The fake mail control port also serves a fake Brevo API.
        NEXUS_BREVO_API_URL: `http://127.0.0.1:${FAKE_MAIL.control}/v3`,
      },
      url: `http://127.0.0.1:${API_PORT}/api/health/ready`,
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      // Separate build directory so the developer's `.next` is untouched.
      command: `npm run build && npx next start --hostname 127.0.0.1 --port ${PORT}`,
      env: { NEXUS_BACKEND_URL: `http://127.0.0.1:${API_PORT}`, NEXT_DIST_DIR: ".next-e2e" },
      url: `http://127.0.0.1:${PORT}/healthz`,
      timeout: 240_000,
      reuseExistingServer: false,
    },
  ],
});
