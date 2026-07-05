// Browser stand-in for "@opentui/core" (aliased by the /app.js build plugin).
// The TUI tree only touches TextAttributes.UNDERLINE and RGBA.fromHex(...).buffer
// (the latter at module top-level for the KoiPond, which never mounts on web).
export const TextAttributes = {
  NONE: 0,
  BOLD: 1,
  DIM: 2,
  ITALIC: 4,
  UNDERLINE: 8,
  BLINK: 16,
  INVERSE: 32,
  HIDDEN: 64,
  STRIKETHROUGH: 128,
} as const;

export const RGBA = {
  fromHex: (_hex: string) => ({ buffer: new Float32Array(4) }),
};

// type-only import sites (erased at compile, present for completeness)
export type OptimizedBuffer = unknown;
