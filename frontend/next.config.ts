import type { NextConfig } from "next";

// The browser only ever talks to this Next.js server. REST calls to /api/* are
// proxied to the FastAPI backend, whose address stays server-side.
const backendUrl = (process.env.NEXUS_BACKEND_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");

// LAN mode (`./start.sh --lan`): the dev server only serves its scripts and hot reload to
// hosts listed here, so the start script passes this machine's network addresses.
const allowedDevOrigins = (process.env.NEXUS_DEV_ORIGINS ?? "").split(/[\s,]+/).filter(Boolean);

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Microphone stays available to this origin for voice (Stage 7); nothing else.
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
];

const nextConfig: NextConfig = {
  // Separate build output for isolated runs (e.g. e2e against a test backend).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  allowedDevOrigins,
  // Development only: keep the Next.js indicator off the HQ camera buttons (bottom-left).
  devIndicators: { position: "bottom-right" },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backendUrl}/api/:path*` }];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
