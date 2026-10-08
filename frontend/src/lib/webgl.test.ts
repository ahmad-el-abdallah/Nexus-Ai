import { describe, expect, it, vi } from "vitest";

import { detectWebGL } from "./webgl";

function fakeDocument(getContext: () => unknown): Document {
  return { createElement: () => ({ getContext }) } as unknown as Document;
}

describe("detectWebGL", () => {
  it("reports unsupported when no WebGL2 context is available", () => {
    expect(detectWebGL(fakeDocument(() => null))).toEqual({ webgl2: false, renderer: null });
  });

  it("reports unsupported instead of throwing when context creation fails", () => {
    const doc = fakeDocument(() => {
      throw new Error("blocked");
    });
    expect(detectWebGL(doc)).toEqual({ webgl2: false, renderer: null });
  });

  it("reports the GPU renderer when WebGL2 is available", () => {
    const loseContext = vi.fn();
    const gl = {
      RENDERER: 0x1f01,
      getExtension: (name: string) =>
        name === "WEBGL_debug_renderer_info"
          ? { UNMASKED_RENDERER_WEBGL: 0x9246 }
          : name === "WEBGL_lose_context"
            ? { loseContext }
            : null,
      getParameter: (p: number) => (p === 0x9246 ? "Intel UHD Graphics" : "WebKit WebGL"),
    };
    expect(detectWebGL(fakeDocument(() => gl))).toEqual({
      webgl2: true,
      renderer: "Intel UHD Graphics",
    });
    expect(loseContext).toHaveBeenCalled();
  });
});
