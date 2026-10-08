import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3200);
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
  webServer: {
    command: `npm run build && npx next start --hostname 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    timeout: 240_000,
    reuseExistingServer: false,
  },
});
