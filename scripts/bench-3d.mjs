#!/usr/bin/env node
// 3D performance benchmark for the headquarters scene.
//
// Opens the office in headless Chrome on this machine's GPU (ANGLE/OpenGL),
// orbits the camera continuously for 10 s per quality level and reports
// frame-time statistics measured inside the page (window.__NEXUS_BENCH__).
//
//   node scripts/bench-3d.mjs [baseUrl] [--uncapped] [--size=1920x1080] [--query=people=off]
//
// --uncapped disables vsync/frame-rate limits to measure headroom; without it
// numbers reflect what a 60 Hz display would show.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const base = args.find((a) => !a.startsWith("--")) ?? "http://127.0.0.1:3000";
const uncapped = args.includes("--uncapped");
const extra = args.find((a) => a.startsWith("--query="))?.slice(8) ?? "";
const [width, height] = (args.find((a) => a.startsWith("--size="))?.slice(7) ?? "1920x1080").split("x").map(Number);
const qualities = ["low", "balanced", "high"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOnce(quality) {
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), "nexus-bench-"));
  const chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--use-angle=gl",
      "--enable-gpu",
      "--ignore-gpu-blocklist",
      ...(uncapped ? ["--disable-gpu-vsync", "--disable-frame-rate-limit"] : []),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  try {
    let target;
    for (let i = 0; i < 80 && !target; i++) {
      await sleep(200);
      try {
        target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
      } catch {}
    }
    if (!target) throw new Error("Chrome did not start");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    });
    const send = (method, params = {}) =>
      new Promise((r) => {
        const i = ++id;
        pending.set(i, r);
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await send("Page.enable");
    await send("Page.navigate", { url: `${base}/?bench=1&quality=${quality}${extra ? `&${extra}` : ""}` });
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      const r = await send("Runtime.evaluate", { expression: "JSON.stringify(window.__NEXUS_BENCH__ ?? null)", returnByValue: true });
      const v = JSON.parse(r.result?.result?.value ?? "null");
      if (v?.done) {
        ws.close();
        return v;
      }
    }
    throw new Error("benchmark timed out");
  } finally {
    chrome.kill();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}

console.log(`NEXUS AI 3D benchmark · ${base} · ${width}×${height} · ${uncapped ? "uncapped" : "vsync (60 Hz)"}`);
const rows = [];
for (const q of qualities) {
  const r = await runOnce(q);
  rows.push(r);
  console.log(
    `${q.padEnd(9)} avg ${String(r.avgFps).padStart(6)} fps · p50 ${r.p50Ms} ms · p95 ${r.p95Ms} ms · p99 ${r.p99Ms} ms · worst ${r.worstMs} ms · ${r.drawCalls} draw calls · ${r.triangles.toLocaleString()} triangles`,
  );
}
console.log(`renderer: ${rows[0]?.renderer}`);
