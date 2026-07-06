// Single source of cell truth for the DOM render target. One measured monospace cell,
// published as --cw/--lh px vars on #root (CSS) and as cols/rows (useTerminalDimensions,
// mouse mapping, pond canvas) — every consumer reads the same numbers, so the text grid,
// the canvas grid, and cell-coordinate math can never drift apart.
export const FONT_SIZE = 14;
export const LINE_H = 19; // fixed px line height; width is the only platform-variable metric
export const FONT_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
export const FONT = `${FONT_SIZE}px/${LINE_H}px ${FONT_STACK}`;

let cw = 8.4;
let cols = 80;
let rows = 24;
let rootEl: HTMLElement | null = null;
const subs = new Set<() => void>();

let blockStretch = 1.2; // scaleY that makes a █ glyph fill the whole 19px cell

function measure(): void {
  const s = document.createElement("span");
  s.textContent = "0".repeat(100);
  s.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${FONT}`;
  document.body.appendChild(s);
  const w = s.getBoundingClientRect().width / 100;
  s.remove();
  if (w > 0) cw = w;
  // block glyphs ink only the font box (~16px of the 19px line), leaving seams when
  // stacked (volume bar rungs). Measure the real ink height so spans can stretch to fill.
  const ctx = document.createElement("canvas").getContext("2d");
  if (ctx) {
    ctx.font = FONT;
    const m = ctx.measureText("█");
    const ink = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    if (ink > 0) blockStretch = LINE_H / ink;
  }
}

function update(): void {
  measure();
  const vw = window.visualViewport?.width ?? window.innerWidth;
  const vh = window.visualViewport?.height ?? window.innerHeight;
  const next = { cols: Math.max(20, Math.floor(vw / cw)), rows: Math.max(10, Math.floor(vh / LINE_H)) };
  rootEl?.style.setProperty("--cw", `${cw}px`);
  rootEl?.style.setProperty("--lh", `${LINE_H}px`);
  rootEl?.style.setProperty("--bs", blockStretch.toFixed(4));
  const changed = next.cols !== cols || next.rows !== rows;
  cols = next.cols;
  rows = next.rows;
  if (changed) subs.forEach((fn) => fn());
}

export function initMetrics(root: HTMLElement): void {
  rootEl = root;
  update();
  window.addEventListener("resize", update);
  window.visualViewport?.addEventListener("resize", update); // iOS keyboard / toolbar
  // late font loads change glyph width without a resize event
  document.fonts?.ready?.then(update).catch(() => {});
}

export function getMetrics(): { cw: number; lh: number; cols: number; rows: number } {
  return { cw, lh: LINE_H, cols, rows };
}

export function onMetrics(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}
