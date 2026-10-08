/**
 * Detects 3D rendering support. The 3D headquarters (Stage 2+) needs WebGL2;
 * browsers without it get the 2D office fallback.
 */

export interface WebGLSupport {
  webgl2: boolean;
  renderer: string | null;
}

export function detectWebGL(doc: Document = document): WebGLSupport {
  try {
    const canvas = doc.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) return { webgl2: false, renderer: null };

    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = debugInfo
      ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { webgl2: true, renderer: renderer || null };
  } catch {
    return { webgl2: false, renderer: null };
  }
}
