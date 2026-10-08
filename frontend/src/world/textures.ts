/**
 * Canvas-drawn textures: floor finishes, monitor lock screens, signage and
 * wall boards. Everything is generated locally (no image downloads), and
 * every board shows real state — never invented figures.
 */

import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from "three";

import type { FloorFinish, WallItemContent } from "./layout/types";

export function fontFamily(): string {
  if (typeof document === "undefined") return "sans-serif";
  const v = getComputedStyle(document.documentElement).getPropertyValue("--font-inter").trim();
  return v ? `${v}, ui-sans-serif, sans-serif` : "ui-sans-serif, sans-serif";
}

export function monoFamily(): string {
  if (typeof document === "undefined") return "monospace";
  const v = getComputedStyle(document.documentElement).getPropertyValue("--font-jetbrains").trim();
  return v ? `${v}, ui-monospace, monospace` : "ui-monospace, monospace";
}

type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

export interface DrawnTexture {
  texture: CanvasTexture;
  redraw: () => void;
}

export function drawnTexture(width: number, height: number, draw: Draw): DrawnTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  const redraw = () => {
    ctx.clearRect(0, 0, width, height);
    draw(ctx, width, height);
    texture.needsUpdate = true;
  };
  redraw();
  return { texture, redraw };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
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

/** The NEXUS isometric cube mark. */
function drawMark(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, alpha = 1) {
  const s = size / 64;
  const pt = (x: number, y: number): [number, number] => [cx + (x - 32) * s, cy + (y - 32) * s];
  const face = (points: [number, number][], a: string, b: string) => {
    const g = ctx.createLinearGradient(points[0][0], points[0][1], points[2][0], points[2][1]);
    g.addColorStop(0, a);
    g.addColorStop(1, b);
    ctx.fillStyle = g;
    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
  };
  ctx.globalAlpha = alpha;
  face([pt(32, 4), pt(58, 19), pt(32, 34), pt(6, 19)], "#c4b5fd", "#22d3ee");
  face([pt(6, 19), pt(32, 34), pt(32, 61), pt(6, 46)], "#8b5cf6", "#4c1d95");
  face([pt(58, 19), pt(32, 34), pt(32, 61), pt(58, 46)], "#22d3ee", "#0e7490");
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Floors
// ---------------------------------------------------------------------------

/** Metres covered by one tile of each floor texture. */
export const FINISH_TILE: Record<FloorFinish, number> = {
  carpet: 2,
  "carpet-indigo": 2,
  stone: 2.4,
  wood: 2,
  tile: 1.2,
};

export function floorTexture(finish: FloorFinish): CanvasTexture {
  const { texture } = drawnTexture(512, 512, (ctx, w, h) => {
    const r = rng(finish.length * 97);
    switch (finish) {
      case "carpet":
      case "carpet-indigo": {
        const base = finish === "carpet" ? "#4a5381" : "#46498a";
        ctx.fillStyle = base;
        ctx.fillRect(0, 0, w, h);
        for (let i = 0; i < 9000; i++) {
          ctx.fillStyle = r() > 0.5 ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.07)";
          ctx.fillRect(r() * w, r() * h, 2, 2);
        }
        // Carpet tile seams (50 cm tiles).
        ctx.strokeStyle = "rgba(0,0,0,0.12)";
        ctx.lineWidth = 2;
        for (let i = 0; i <= 4; i++) {
          ctx.beginPath();
          ctx.moveTo((i * w) / 4, 0);
          ctx.lineTo((i * w) / 4, h);
          ctx.moveTo(0, (i * h) / 4);
          ctx.lineTo(w, (i * h) / 4);
          ctx.stroke();
        }
        break;
      }
      case "stone": {
        ctx.fillStyle = "#c9d0e2";
        ctx.fillRect(0, 0, w, h);
        for (let i = 0; i < 14; i++) {
          ctx.strokeStyle = `rgba(120,130,160,${0.08 + r() * 0.1})`;
          ctx.lineWidth = 1 + r() * 2;
          ctx.beginPath();
          let x = r() * w;
          let y = r() * h;
          ctx.moveTo(x, y);
          for (let k = 0; k < 6; k++) {
            x += (r() - 0.5) * 140;
            y += (r() - 0.3) * 90;
            ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        ctx.strokeStyle = "rgba(90,100,130,0.35)";
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, w / 2 - 2, h / 2 - 2);
        ctx.strokeRect(w / 2 + 1, 1, w / 2 - 2, h / 2 - 2);
        ctx.strokeRect(1, h / 2 + 1, w / 2 - 2, h / 2 - 2);
        ctx.strokeRect(w / 2 + 1, h / 2 + 1, w / 2 - 2, h / 2 - 2);
        break;
      }
      case "wood": {
        const planks = 8;
        const ph = h / planks;
        for (let i = 0; i < planks; i++) {
          const tone = 150 + Math.floor(r() * 30);
          ctx.fillStyle = `rgb(${tone + 40},${tone - 2},${tone - 45})`;
          ctx.fillRect(0, i * ph, w, ph);
          for (let k = 0; k < 40; k++) {
            ctx.strokeStyle = `rgba(80,45,20,${0.05 + r() * 0.08})`;
            ctx.beginPath();
            const y = i * ph + r() * ph;
            ctx.moveTo(0, y);
            ctx.bezierCurveTo(w * 0.3, y + (r() - 0.5) * 6, w * 0.6, y + (r() - 0.5) * 6, w, y);
            ctx.stroke();
          }
          ctx.fillStyle = "rgba(40,20,10,0.35)";
          ctx.fillRect(0, i * ph, w, 2);
          const joint = r() * w;
          ctx.fillRect(joint, i * ph, 2, ph);
        }
        break;
      }
      case "tile": {
        ctx.fillStyle = "#dfe4ee";
        ctx.fillRect(0, 0, w, h);
        const n = 4;
        for (let y = 0; y < n; y++)
          for (let x = 0; x < n; x++) {
            ctx.fillStyle = (x + y) % 2 ? "#e8ecf3" : "#cfd6e3";
            ctx.fillRect((x * w) / n + 2, (y * h) / n + 2, w / n - 4, h / n - 4);
          }
        break;
      }
    }
  });
  texture.wrapS = texture.wrapT = RepeatWrapping;
  return texture;
}

// ---------------------------------------------------------------------------
// Screens & signage
// ---------------------------------------------------------------------------

/** Idle monitor: no employee is assigned to any desk yet. */
export function lockScreenTexture(): DrawnTexture {
  return drawnTexture(512, 296, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "#0b1230");
    g.addColorStop(1, "#1a1446");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const glow = ctx.createRadialGradient(w / 2, h * 0.42, 10, w / 2, h * 0.42, w * 0.5);
    glow.addColorStop(0, "rgba(139,92,246,0.35)");
    glow.addColorStop(1, "rgba(139,92,246,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    drawMark(ctx, w / 2, h * 0.4, 84);
    ctx.fillStyle = "rgba(231,234,246,0.9)";
    ctx.font = `600 26px ${fontFamily()}`;
    ctx.textAlign = "center";
    ctx.fillText("NEXUS", w / 2, h * 0.73);
    ctx.fillStyle = "rgba(139,147,181,0.9)";
    ctx.font = `500 17px ${fontFamily()}`;
    ctx.fillText("Workstation available", w / 2, h * 0.85);
  });
}

function panel(ctx: CanvasRenderingContext2D, w: number, h: number, accent: string) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#111833");
  g.addColorStop(1, "#0a0f24");
  ctx.fillStyle = g;
  roundRect(ctx, 0, 0, w, h, Math.min(w, h) * 0.06);
  ctx.fill();
  ctx.strokeStyle = `${accent}66`;
  ctx.lineWidth = Math.max(3, h * 0.012);
  roundRect(ctx, 2, 2, w - 4, h - 4, Math.min(w, h) * 0.06);
  ctx.stroke();
}

/** Pixel size of a wall item's canvas, keeping its aspect ratio. */
export function wallItemCanvasSize(width: number, height: number): [number, number] {
  const scale = 300;
  return [Math.min(2048, Math.round(width * scale)), Math.min(2048, Math.round(height * scale))];
}

export function drawWallItem(ctx: CanvasRenderingContext2D, w: number, h: number, content: WallItemContent, accent: string, now: Date) {
  const font = fontFamily();
  const mono = monoFamily();
  ctx.textBaseline = "middle";
  switch (content.kind) {
    case "sign": {
      panel(ctx, w, h, accent);
      ctx.fillStyle = accent;
      roundRect(ctx, h * 0.22, h * 0.22, h * 0.07, h * 0.56, h * 0.035);
      ctx.fill();
      ctx.textAlign = "left";
      ctx.fillStyle = "#eef1fb";
      ctx.font = `700 ${h * 0.4}px ${font}`;
      ctx.fillText(content.title.toUpperCase(), h * 0.48, h * 0.44);
      ctx.fillStyle = accent;
      ctx.font = `600 ${h * 0.16}px ${font}`;
      ctx.fillText(content.subtitle.toUpperCase(), h * 0.5, h * 0.76);
      break;
    }
    case "logo": {
      panel(ctx, w, h, accent);
      drawMark(ctx, h * 0.55, h * 0.5, h * 0.62);
      const g = ctx.createLinearGradient(h, 0, w * 0.9, 0);
      g.addColorStop(0, "#c4b5fd");
      g.addColorStop(0.5, "#8b5cf6");
      g.addColorStop(1, "#22d3ee");
      ctx.fillStyle = g;
      ctx.textAlign = "left";
      ctx.font = `800 ${h * 0.34}px ${font}`;
      ctx.fillText("NEXUS AI", h * 1.0, h * 0.42);
      ctx.fillStyle = "#9aa3c7";
      ctx.font = `600 ${h * 0.11}px ${font}`;
      ctx.fillText("YOUR CORPORATION. YOUR AI WORKFORCE.", h * 1.02, h * 0.72);
      break;
    }
    case "clock": {
      panel(ctx, w, h, accent);
      ctx.textAlign = "center";
      ctx.fillStyle = "#eef1fb";
      ctx.font = `600 ${h * 0.44}px ${mono}`;
      ctx.fillText(now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), w / 2, h * 0.42);
      ctx.fillStyle = accent;
      ctx.font = `600 ${h * 0.15}px ${font}`;
      ctx.fillText(now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }).toUpperCase(), w / 2, h * 0.78);
      break;
    }
    case "welcome": {
      panel(ctx, w, h, accent);
      ctx.textAlign = "center";
      ctx.fillStyle = "#eef1fb";
      ctx.font = `700 ${h * 0.26}px ${font}`;
      ctx.fillText("Welcome", w / 2, h * 0.4);
      ctx.fillStyle = accent;
      ctx.font = `600 ${h * 0.13}px ${font}`;
      ctx.fillText("NEXUS HEADQUARTERS", w / 2, h * 0.72);
      break;
    }
    case "board": {
      panel(ctx, w, h, accent);
      const pad = h * 0.08;
      ctx.textAlign = "left";
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(pad + h * 0.03, pad + h * 0.05, h * 0.025, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#eef1fb";
      ctx.font = `700 ${h * 0.085}px ${font}`;
      ctx.fillText(content.title, pad + h * 0.09, pad + h * 0.05);
      ctx.strokeStyle = "rgba(148,163,255,0.18)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pad, pad + h * 0.14);
      ctx.lineTo(w - pad, pad + h * 0.14);
      ctx.stroke();
      // Empty state: an outlined circle and the honest status line.
      ctx.strokeStyle = `${accent}99`;
      ctx.lineWidth = h * 0.012;
      ctx.setLineDash([h * 0.03, h * 0.025]);
      ctx.beginPath();
      ctx.arc(w / 2, h * 0.5, h * 0.1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.textAlign = "center";
      ctx.fillStyle = "#d9def0";
      ctx.font = `600 ${h * 0.075}px ${font}`;
      ctx.fillText(content.body, w / 2, h * 0.73);
      ctx.fillStyle = "#7d86ab";
      ctx.font = `500 ${h * 0.05}px ${font}`;
      ctx.fillText("Live data appears here once work begins", w / 2, h * 0.84);
      break;
    }
    case "moodboard": {
      panel(ctx, w, h, accent);
      const r = rng(5);
      const swatches = ["#f472b6", "#c084fc", "#22d3ee", "#fbbf24", "#34d399", "#fb7185"];
      const pad = h * 0.08;
      ctx.textAlign = "left";
      ctx.fillStyle = "#eef1fb";
      ctx.font = `700 ${h * 0.08}px ${font}`;
      ctx.fillText("Brand mood board", pad, pad + h * 0.03);
      const cols = 6;
      const cw = (w - pad * 2 - (cols - 1) * 12) / cols;
      swatches.forEach((c, i) => {
        ctx.fillStyle = c;
        roundRect(ctx, pad + i * (cw + 12), h * 0.22, cw, h * 0.22, 10);
        ctx.fill();
      });
      ctx.fillStyle = "#eef1fb";
      ctx.font = `800 ${h * 0.3}px ${font}`;
      ctx.fillText("Aa", pad, h * 0.68);
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = swatches[(i + 2) % swatches.length];
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(w * 0.45 + i * h * 0.22, h * 0.68, h * (0.06 + r() * 0.05), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      break;
    }
    case "menu": {
      panel(ctx, w, h, accent);
      ctx.textAlign = "left";
      ctx.fillStyle = accent;
      ctx.font = `800 ${h * 0.18}px ${font}`;
      ctx.fillText("CAFÉ", h * 0.12, h * 0.2);
      ctx.fillStyle = "#d9def0";
      ctx.font = `500 ${h * 0.1}px ${font}`;
      ["Espresso", "Flat white", "Matcha latte", "Fresh juice"].forEach((item, i) => {
        ctx.fillText(item, h * 0.14 + (i % 2) * w * 0.48, h * (0.48 + Math.floor(i / 2) * 0.24));
      });
      break;
    }
    case "ambient": {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, "#0d1640");
      g.addColorStop(0.5, "#2b1a5c");
      g.addColorStop(1, "#0a3346");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 5; i++) {
        ctx.strokeStyle = `rgba(${i % 2 ? "34,211,238" : "167,139,250"},${0.25 + i * 0.08})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        for (let x = 0; x <= w; x += 8) {
          const y = h * (0.55 + i * 0.05) + Math.sin(x / (60 + i * 12) + i) * h * 0.08;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      drawMark(ctx, w / 2, h * 0.32, h * 0.3, 0.9);
      break;
    }
  }
}
