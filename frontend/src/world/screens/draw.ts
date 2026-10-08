/**
 * Draws a desk monitor (512×296 canvas) from a MonitorView: role-styled app
 * chrome around real content. Chrome (menus, gutters, grid lines) is decoration;
 * every word of content comes from the view.
 */

import { fontFamily, monoFamily } from "../textures";
import type { App, MonitorView } from "./model";

export const SCREEN_W = 512;
export const SCREEN_H = 296;

interface Palette {
  bg: string;
  chrome: string;
  chromeText: string;
  text: string;
  dim: string;
  heading: string;
  accent: string;
  code: string;
  page?: string;
}

const PALETTE: Record<App, Palette> = {
  code: { bg: "#0d1117", chrome: "#161b22", chromeText: "#8b949e", text: "#c9d1d9", dim: "#6e7681", heading: "#d2a8ff", accent: "#58a6ff", code: "#ffa657" },
  terminal: { bg: "#06090a", chrome: "#121815", chromeText: "#6b8f71", text: "#7ee787", dim: "#3b5f42", heading: "#b6f5bf", accent: "#3fb950", code: "#e3b341" },
  notebook: { bg: "#1e1e2e", chrome: "#181825", chromeText: "#9399b2", text: "#cdd6f4", dim: "#6c7086", heading: "#f5c2e7", accent: "#89b4fa", code: "#fab387" },
  design: { bg: "#2b2d31", chrome: "#1e1f22", chromeText: "#b5bac1", text: "#1f2328", dim: "#8b8f97", heading: "#111318", accent: "#a970ff", code: "#9a3412", page: "#ffffff" },
  docs: { bg: "#e9ecf2", chrome: "#f8f9fb", chromeText: "#57606a", text: "#24292f", dim: "#8c959f", heading: "#0d1117", accent: "#2563eb", code: "#9a3412", page: "#ffffff" },
  crm: { bg: "#f3f5f9", chrome: "#1e2a44", chromeText: "#c7d2fe", text: "#1f2937", dim: "#94a3b8", heading: "#0f172a", accent: "#f59e0b", code: "#9a3412", page: "#ffffff" },
  sheet: { bg: "#ffffff", chrome: "#107c41", chromeText: "#e6f4ea", text: "#1f2937", dim: "#9ca3af", heading: "#065f46", accent: "#107c41", code: "#9a3412", page: "#ffffff" },
  legal: { bg: "#e7e5e4", chrome: "#f5f5f4", chromeText: "#57534e", text: "#1c1917", dim: "#a8a29e", heading: "#0c0a09", accent: "#7c2d12", code: "#7c2d12", page: "#fffefb" },
  brief: { bg: "#0f172a", chrome: "#0b1120", chromeText: "#94a3b8", text: "#e2e8f0", dim: "#64748b", heading: "#f8fafc", accent: "#a78bfa", code: "#fbbf24" },
};

const TONE_COLOR: Record<MonitorView["tone"], string> = {
  live: "#22c55e",
  thinking: "#38bdf8",
  done: "#22c55e",
  failed: "#ef4444",
  idle: "#94a3b8",
};

type Line = { text: string; style: "heading" | "bullet" | "code" | "text" | "blank" };

/** Light Markdown → styled lines (no HTML; just what reads well on a small screen). */
export function markdownLines(text: string): Line[] {
  const out: Line[] = [];
  let inCode = false;
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    if (/^\s*```/.test(raw)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push({ text: raw.replace(/\t/g, "  "), style: "code" });
      continue;
    }
    const line = raw.replace(/\*\*|__|`/g, "").trimEnd();
    if (!line.trim()) out.push({ text: "", style: "blank" });
    else if (/^\s{0,3}#{1,6}\s/.test(line)) out.push({ text: line.replace(/^\s*#+\s*/, ""), style: "heading" });
    else if (/^\s*[-*+]\s+/.test(line)) out.push({ text: `• ${line.replace(/^\s*[-*+]\s+/, "")}`, style: "bullet" });
    else out.push({ text: line, style: "text" });
  }
  return out;
}

function wrap(ctx: CanvasRenderingContext2D, line: Line, width: number): Line[] {
  if (line.style === "blank" || !line.text) return [line];
  const words = line.text.split(/(\s+)/);
  const out: Line[] = [];
  let current = "";
  for (const word of words) {
    const next = current + word;
    if (ctx.measureText(next).width <= width || !current) {
      // Very long tokens (URLs, code) are hard-cut.
      if (ctx.measureText(next).width > width && !current) {
        let piece = "";
        for (const ch of next) {
          if (ctx.measureText(piece + ch).width > width) {
            out.push({ text: piece, style: line.style });
            piece = "";
          }
          piece += ch;
        }
        current = piece;
      } else {
        current = next;
      }
    } else {
      out.push({ text: current.trimEnd(), style: line.style });
      current = word.trimStart();
    }
  }
  if (current) out.push({ text: current.trimEnd(), style: line.style });
  return out.map((l, i) => (i > 0 && l.style === "bullet" ? { ...l, text: `  ${l.text}` } : l));
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function clip(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let s = text;
  while (s && ctx.measureText(`${s}…`).width > width) s = s.slice(0, -1);
  return `${s}…`;
}

/** Writes wrapped lines into a box; `tail` keeps the newest lines (live typing). */
function textBlock(
  ctx: CanvasRenderingContext2D,
  v: MonitorView,
  p: Palette,
  box: { x: number; y: number; w: number; h: number },
  opts: { mono: boolean; size: number; gutter?: boolean; caret?: boolean },
) {
  const lineHeight = Math.round(opts.size * 1.45);
  const fontFor = (style: Line["style"]) =>
    `${style === "heading" ? 700 : 400} ${style === "heading" && !opts.mono ? opts.size + 1 : opts.size}px ${opts.mono || style === "code" ? monoFamily() : fontFamily()}`;
  const gutter = opts.gutter ? 26 : 0;
  const width = box.w - gutter;
  const lines: Line[] = [];
  for (const line of markdownLines(v.body)) {
    ctx.font = fontFor(line.style);
    lines.push(...wrap(ctx, line, width));
  }
  const fit = Math.max(1, Math.floor(box.h / lineHeight));
  const start = v.tail ? Math.max(0, lines.length - fit) : 0;
  const shown = lines.slice(start, start + fit);
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  shown.forEach((line, i) => {
    const y = box.y + i * lineHeight;
    if (opts.gutter) {
      ctx.font = `400 ${opts.size - 1}px ${monoFamily()}`;
      ctx.fillStyle = p.dim;
      ctx.textAlign = "right";
      ctx.fillText(String(start + i + 1), box.x + gutter - 8, y);
      ctx.textAlign = "left";
    }
    ctx.font = fontFor(line.style);
    ctx.fillStyle = line.style === "heading" ? p.heading : line.style === "code" ? p.code : line.style === "bullet" ? p.text : p.text;
    if (line.style === "bullet") {
      ctx.fillStyle = p.accent;
      ctx.fillText(line.text.slice(0, 1), box.x + gutter, y);
      ctx.fillStyle = p.text;
      ctx.fillText(line.text.slice(1), box.x + gutter + ctx.measureText(line.text.slice(0, 1)).width, y);
    } else {
      ctx.fillText(line.text, box.x + gutter, y);
    }
  });
  if (opts.caret && v.tone === "live") {
    const last = shown[shown.length - 1];
    ctx.font = fontFor(last?.style ?? "text");
    const x = box.x + gutter + (last ? ctx.measureText(last.text).width + 2 : 0);
    const y = box.y + Math.max(0, shown.length - 1) * lineHeight;
    ctx.fillStyle = p.accent;
    ctx.fillRect(x, y + 1, Math.max(2, opts.size * 0.18), opts.size + 2);
  }
  if (!v.body) {
    ctx.font = `italic 400 ${opts.size}px ${fontFamily()}`;
    ctx.fillStyle = p.dim;
    ctx.fillText(v.role === "brief" ? "—" : v.tone === "thinking" ? v.status : "", box.x + gutter, box.y);
  }
}

function titleBar(ctx: CanvasRenderingContext2D, v: MonitorView, p: Palette, w: number) {
  ctx.fillStyle = p.chrome;
  ctx.fillRect(0, 0, w, 24);
  ["#ff5f57", "#febc2e", "#28c840"].forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(12 + i * 13, 12, 4, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.font = `600 11px ${fontFamily()}`;
  ctx.fillStyle = p.chromeText;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(clip(ctx, `${v.appName}${v.file ? ` — ${v.file}` : ""}`, w - 70 - 140), 56, 12);
  ctx.textAlign = "right";
  ctx.fillText(clip(ctx, v.person, 130), w - 8, 12);
}

function statusBar(ctx: CanvasRenderingContext2D, v: MonitorView, p: Palette, w: number, h: number, dark: boolean) {
  ctx.fillStyle = dark ? p.chrome : "#eef1f5";
  ctx.fillRect(0, h - 20, w, 20);
  ctx.fillStyle = TONE_COLOR[v.tone];
  ctx.beginPath();
  ctx.arc(11, h - 10, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `500 11px ${fontFamily()}`;
  ctx.fillStyle = dark ? p.chromeText : "#57606a";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(clip(ctx, v.status, w - 30), 21, h - 10);
}

function headingBlock(ctx: CanvasRenderingContext2D, v: MonitorView, p: Palette, x: number, y: number, w: number): number {
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.font = `700 14px ${fontFamily()}`;
  ctx.fillStyle = p.heading;
  ctx.fillText(clip(ctx, v.heading, w), x, y);
  let used = 20;
  if (v.context) {
    ctx.font = `400 10px ${fontFamily()}`;
    ctx.fillStyle = p.dim;
    ctx.fillText(clip(ctx, v.context.replace(/\s+/g, " "), w), x, y + used);
    used += 16;
  }
  return used + 4;
}

export function drawMonitor(ctx: CanvasRenderingContext2D, v: MonitorView, w = SCREEN_W, h = SCREEN_H) {
  ctx.clearRect(0, 0, w, h);
  if (v.mode === "off") {
    ctx.fillStyle = "#05070d";
    ctx.fillRect(0, 0, w, h);
    return;
  }
  const p = PALETTE[v.app];
  const dark = ["code", "terminal", "notebook", "brief"].includes(v.app);
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, w, h);
  titleBar(ctx, v, p, w);
  const top = 24;
  const bottom = h - 20;

  if (v.mode === "idle") {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `600 20px ${fontFamily()}`;
    ctx.fillStyle = dark ? p.heading : p.heading;
    ctx.fillText(clip(ctx, v.heading, w - 40), w / 2, h * 0.45);
    ctx.font = `400 13px ${fontFamily()}`;
    ctx.fillStyle = p.dim;
    ctx.fillText(clip(ctx, v.personRole, w - 40), w / 2, h * 0.45 + 24);
    if (v.body) ctx.fillText(v.body, w / 2, h * 0.45 + 46);
    statusBar(ctx, v, p, w, h, dark);
    return;
  }

  switch (v.app) {
    case "code": {
      // Tabs and a gutter with line numbers, like an IDE.
      ctx.fillStyle = "#010409";
      ctx.fillRect(0, top, w, 20);
      ctx.fillStyle = p.bg;
      ctx.fillRect(6, top + 2, 150, 18);
      ctx.font = `500 10px ${monoFamily()}`;
      ctx.fillStyle = p.text;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(clip(ctx, v.file || "untitled", 136), 14, top + 11);
      ctx.fillStyle = p.chrome;
      ctx.fillRect(0, top + 20, 30, bottom - top - 20);
      const y = top + 26;
      ctx.font = `600 10px ${monoFamily()}`;
      ctx.fillStyle = p.dim;
      ctx.textBaseline = "top";
      ctx.fillText(clip(ctx, `// ${v.heading}`, w - 46), 34, y);
      textBlock(ctx, v, p, { x: 4, y: y + 16, w: w - 12, h: bottom - y - 20 }, { mono: true, size: 10, gutter: true, caret: true });
      break;
    }
    case "terminal": {
      const y = top + 8;
      ctx.font = `500 10px ${monoFamily()}`;
      ctx.fillStyle = p.accent;
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.fillText(clip(ctx, `$ nexus task "${v.heading}"`, w - 20), 10, y);
      textBlock(ctx, v, p, { x: 10, y: y + 18, w: w - 20, h: bottom - y - 24 }, { mono: true, size: 10, caret: true });
      break;
    }
    case "notebook": {
      ctx.font = `600 10px ${monoFamily()}`;
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.fillStyle = p.accent;
      ctx.fillText("In [1]:", 8, top + 10);
      ctx.fillStyle = "#313244";
      roundRect(ctx, 56, top + 6, w - 64, 22, 4);
      ctx.fill();
      ctx.fillStyle = p.text;
      ctx.fillText(clip(ctx, v.heading, w - 80), 64, top + 12);
      ctx.fillStyle = p.code;
      ctx.fillText("Out:", 8, top + 40);
      textBlock(ctx, v, p, { x: 56, y: top + 38, w: w - 64, h: bottom - top - 44 }, { mono: false, size: 11, caret: true });
      break;
    }
    case "design": {
      // Toolbar and an artboard on a canvas.
      ctx.fillStyle = p.chrome;
      ctx.fillRect(0, top, 28, bottom - top);
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = i === 0 ? p.accent : "#4e5058";
        roundRect(ctx, 7, top + 10 + i * 24, 14, 14, 3);
        ctx.fill();
      }
      ctx.fillStyle = p.page!;
      roundRect(ctx, 44, top + 12, w - 60, bottom - top - 24, 4);
      ctx.fill();
      const used = headingBlock(ctx, v, p, 58, top + 22, w - 88);
      textBlock(ctx, v, p, { x: 58, y: top + 22 + used, w: w - 88, h: bottom - top - 50 - used }, { mono: false, size: 11, caret: true });
      break;
    }
    case "crm": {
      ctx.fillStyle = p.chrome;
      ctx.fillRect(0, top, 96, bottom - top);
      ctx.font = `500 10px ${fontFamily()}`;
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ["Inbox", "Contacts", "Deals", "Tasks"].forEach((label, i) => {
        if (label === "Tasks") {
          ctx.fillStyle = "rgba(255,255,255,0.12)";
          ctx.fillRect(0, top + 10 + i * 22 - 4, 96, 20);
        }
        ctx.fillStyle = p.chromeText;
        ctx.fillText(label, 14, top + 10 + i * 22);
      });
      ctx.fillStyle = p.page!;
      roundRect(ctx, 108, top + 10, w - 120, bottom - top - 20, 6);
      ctx.fill();
      ctx.fillStyle = p.accent;
      ctx.fillRect(108, top + 10, 4, bottom - top - 20);
      const used = headingBlock(ctx, v, p, 122, top + 20, w - 144);
      textBlock(ctx, v, p, { x: 122, y: top + 20 + used, w: w - 144, h: bottom - top - 40 - used }, { mono: false, size: 11, caret: true });
      break;
    }
    case "sheet": {
      ctx.fillStyle = "#f3f4f6";
      ctx.fillRect(0, top, w, 16);
      ctx.fillRect(0, top, 26, bottom - top);
      ctx.strokeStyle = "#e5e7eb";
      ctx.lineWidth = 1;
      ctx.font = `600 9px ${fontFamily()}`;
      ctx.fillStyle = "#6b7280";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const cols = ["A", "B", "C", "D", "E"];
      cols.forEach((c, i) => {
        const x = 26 + (i * (w - 26)) / cols.length;
        ctx.fillText(c, x + (w - 26) / cols.length / 2, top + 8);
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.stroke();
      });
      for (let r = 0; r * 15 + top + 16 < bottom; r++) {
        const y = top + 16 + r * 15;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        ctx.fillText(String(r + 1), 13, y + 7.5);
      }
      const used = headingBlock(ctx, v, p, 32, top + 20, w - 44);
      textBlock(ctx, v, p, { x: 32, y: top + 20 + used, w: w - 44, h: bottom - top - 26 - used }, { mono: false, size: 10, caret: true });
      break;
    }
    case "legal":
    case "docs":
    case "brief": {
      const page = v.app !== "brief";
      if (page) {
        ctx.fillStyle = p.page!;
        ctx.fillRect(40, top + 8, w - 80, bottom - top - 8);
      }
      const x = page ? 58 : 18;
      const width = page ? w - 116 : w - 36;
      if (v.app === "brief") {
        ctx.fillStyle = p.accent;
        ctx.fillRect(18, top + 14, 3, 18);
      }
      const used = headingBlock(ctx, v, p, v.app === "brief" ? 28 : x, top + 16, width);
      textBlock(ctx, v, p, { x, y: top + 16 + used, w: width, h: bottom - top - 22 - used }, { mono: false, size: 11, gutter: v.app === "legal", caret: true });
      break;
    }
  }
  statusBar(ctx, v, p, w, h, dark);
}
