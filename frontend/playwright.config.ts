import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3200);
const API_PORT = Number(process.env.E2E_API_PORT ?? 18200);
const DB = `/tmp/nexus-e2e-${API_PORT}.db`;
// Render with the machine's GPU through ANGLE/OpenGL; headless Chrome would
// otherwise use the much slower SwiftShader software renderer.
const GPU_ARGS = process.env.E2E_SOFTWARE_GL ? [] : ["--use-angle=gl", "--enable-gpu", "--ignore-gpu-blocklist"];

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
      use: { viewport: { width: 1440, height: 900 }, launchOptions: { args: GPU_ARGS } },
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
      // Isolated backend with a fresh, migrated throwaway database.
      command: `rm -f ${DB}* && uv run --frozen alembic upgrade head && uv run --frozen python -m app`,
      cwd: "../backend",
      env: { NEXUS_DATABASE_URL: `sqlite+aiosqlite:///${DB}`, NEXUS_PORT: String(API_PORT), NEXUS_ENV: "test", NEXUS_LOG_LEVEL: "WARNING" },
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
