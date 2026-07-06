// Koi pond for the DOM app: same PondSim as the server TUI, rendered as REAL text on the
// same cell grid as the app (one span per cell, same font/line boxes) — not a canvas
// underlay. Text rows paint their opaque PANEL strips over it exactly like the TUI's cell
// buffers, so koi and ripples flow through every gap the content leaves, in one medium.
// Cell metrics come from metrics.ts, so this grid and the DOM text grid are identical by
// construction. (web/pond.ts still serves the legacy xterm page until cutover.)
import {
  PondSim,
  PAL_HEX,
  WATER_CP,
  WATER_CREST_HEX,
  WATER_TROUGH_HEX,
  CP_FULL,
  CP_HALF,
  CP_EYE,
  C_EYE,
  waterBucket,
  MOVE_AMP,
  DOWN_AMP,
} from "../../src/lib/pond";
import { FONT, getMetrics, onMetrics } from "./metrics";

const WATER_CH = WATER_CP.map((c) => String.fromCharCode(c)); // index 0 = " " (calm)
const FULL_CH = String.fromCharCode(CP_FULL);
const HALF_CH = String.fromCharCode(CP_HALF);
const EYE_CH = String.fromCharCode(CP_EYE);

export function startPond(app: HTMLElement): void {
  const layer = document.createElement("div");
  // input flows to the app; we listen on the container (same contract as before)
  layer.style.cssText = `position:absolute;left:0;top:0;pointer-events:none;font:${FONT};`;
  app.insertBefore(layer, app.firstChild); // behind #root, inside the CRT filter

  let { cols, rows } = getMetrics();
  let sim = new PondSim(cols, rows, cols < 64 ? 0.5 : 1);
  let spans: HTMLSpanElement[] = [];
  // mirrors of what's in the DOM, so a frame only touches spans that changed
  let chars: string[] = [];
  let colors: string[] = [];
  // cell-exclusivity mask: a terminal cell holds ONE glyph, so cells occupied by app
  // text (or painted boxes/inputs) are off-limits to the pond — koi swim under content
  // and reappear, never double-striking a cell. Rebuilt from live DOM geometry.
  let mask = new Uint8Array(0);
  let maskDirty = true;
  const root = document.getElementById("root");

  function rebuildMask() {
    mask.fill(0);
    if (!root) return;
    const m = getMetrics();
    const base = layer.getBoundingClientRect();
    const mark = (r: DOMRect) => {
      if (r.width <= 0.5 || r.height <= 0.5) return;
      // quarter-cell fudge: subpixel bleed must not claim a neighbouring cell
      const x0 = Math.max(0, Math.floor((r.left - base.left + m.cw * 0.25) / m.cw));
      const x1 = Math.min(cols - 1, Math.floor((r.right - base.left - m.cw * 0.25) / m.cw));
      const y0 = Math.max(0, Math.floor((r.top - base.top + m.lh * 0.25) / m.lh));
      const y1 = Math.min(rows - 1, Math.floor((r.bottom - base.top - m.lh * 0.25) / m.lh));
      for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) mask[y * cols + x] = 1;
    };
    // only INKED glyphs claim cells. Spaces are pond-owned — the TUI renderer skips
    // transparent-bg space cells entirely, so water shows between words there too.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const word = /\S+/g;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const sv = n.nodeValue;
      if (!sv || sv.trim() === "") continue; // JSX formatting whitespace
      word.lastIndex = 0;
      let mm: RegExpExecArray | null;
      while ((mm = word.exec(sv))) {
        range.setStart(n, mm.index);
        range.setEnd(n, mm.index + mm[0].length);
        const rects = range.getClientRects();
        for (let i = 0; i < rects.length; i += 1) mark(rects[i]);
      }
    }
    // elements that paint (background, border) occlude their whole box; an input claims
    // only its text (value or placeholder) plus a caret cell — the rest of the field is
    // pond, same as the TUI input's untouched space cells
    const els = root.querySelectorAll<HTMLElement>("*");
    for (let i = 0; i < els.length; i += 1) {
      const el = els[i];
      if (el.tagName === "INPUT") {
        const inp = el as HTMLInputElement;
        const txt = inp.value || inp.placeholder || "";
        const r = el.getBoundingClientRect();
        mark(new DOMRect(r.x, r.y, Math.min(r.width, (txt.length + 1) * m.cw), r.height));
        continue;
      }
      const s = el.style;
      const paints =
        (s.background !== "" && s.background !== "transparent") ||
        (s.backgroundColor !== "" && s.backgroundColor !== "transparent") ||
        s.border !== "";
      if (paints) mark(el.getBoundingClientRect());
    }
  }
  // any DOM change under #root can move text; re-measure on the next frame. Typing
  // changes an input's value PROPERTY (no mutation record), so listen for it too.
  if (root) new MutationObserver(() => (maskDirty = true)).observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  app.addEventListener("input", () => (maskDirty = true), true);
  document.fonts?.ready?.then(() => (maskDirty = true)).catch(() => {});

  // (re)build the span grid; a resize also resets the sim — koi swim back in from the
  // edges, which reads as the intentional intro (the TUI does the same on resize)
  function build() {
    const m = getMetrics();
    cols = m.cols;
    rows = m.rows;
    sim = new PondSim(cols, rows, cols < 64 ? 0.5 : 1);
    layer.textContent = "";
    spans = new Array(cols * rows);
    chars = new Array(cols * rows).fill(" ");
    colors = new Array(cols * rows).fill("");
    mask = new Uint8Array(cols * rows);
    maskDirty = true;
    for (let y = 0; y < rows; y += 1) {
      const row = document.createElement("div");
      row.style.cssText = `height:${m.lh}px;white-space:pre;`;
      for (let x = 0; x < cols; x += 1) {
        const s = document.createElement("span");
        s.textContent = " ";
        row.appendChild(s);
        spans[y * cols + x] = s;
      }
      layer.appendChild(row);
    }
  }
  build();
  onMetrics(build); // fires only when cols/rows change; glyph-width drift just reflows

  // pointer → ripples. Gate splashes on cell change so splash rate stays sane.
  let lastCellX = -1;
  let lastCellY = -1;
  let moveN = 0;
  function cellOf(e: PointerEvent): { x: number; y: number } {
    const m = getMetrics();
    const r = layer.getBoundingClientRect();
    return { x: Math.floor((e.clientX - r.left) / m.cw), y: Math.floor((e.clientY - r.top) / m.lh) };
  }
  app.addEventListener("pointermove", (e) => {
    const c = cellOf(e);
    sim.mouse = c; // koi flee the cursor
    if (c.x === lastCellX && c.y === lastCellY) return;
    lastCellX = c.x;
    lastCellY = c.y;
    if (moveN++ % 2 === 0) sim.splash(c.x, c.y, MOVE_AMP);
  });
  app.addEventListener("pointerdown", (e) => {
    const c = cellOf(e);
    sim.splash(c.x, c.y, DOWN_AMP);
  });
  app.addEventListener("pointerleave", () => {
    sim.mouse = null;
  });

  // rAF loop — pauses automatically in background tabs; PondSim clamps deltaMs at 100ms
  let last = performance.now();
  let frames = 0;
  function frame(now: number) {
    sim.step(now - last);
    last = now;
    // re-measure occupancy at frame start (layout is clean before our span writes);
    // the once-a-second fallback catches geometry drift no mutation reports (zoom, DPR)
    if (maskDirty || frames++ % 60 === 0) {
      rebuildMask();
      maskDirty = false;
    }
    const buf = sim.px;
    const field = sim.field;
    const PW = sim.PW;
    const W = sim.W;
    const drawCols = Math.min(cols, sim.W);
    const drawRows = Math.min(rows, sim.H);
    for (let y = 0; y < drawRows; y += 1) {
      const top0 = 2 * y * PW;
      const bot0 = top0 + PW;
      const rowOff = y * cols;
      for (let x = 0; x < drawCols; x += 1) {
        const i0 = rowOff + x;
        if (mask[i0]) {
          // cell belongs to app content — a real terminal cell can hold only one glyph
          if (chars[i0] !== " ") {
            chars[i0] = " ";
            spans[i0].textContent = " ";
          }
          continue;
        }
        const top = buf[top0 + x];
        const bot = buf[bot0 + x];
        let ch: string;
        let col: string;
        if (top || bot) {
          const idx = top || bot;
          ch = idx === C_EYE ? EYE_CH : top && bot ? FULL_CH : HALF_CH;
          col = PAL_HEX[idx];
        } else {
          const v = field[y * W + x];
          const bkt = waterBucket(v < 0 ? -v : v);
          ch = WATER_CH[bkt];
          col = bkt === 0 ? "" : (v > 0 ? WATER_CREST_HEX : WATER_TROUGH_HEX)[bkt];
        }
        const i = rowOff + x;
        if (chars[i] !== ch) {
          chars[i] = ch;
          spans[i].textContent = ch;
        }
        if (col && colors[i] !== col) {
          colors[i] = col;
          spans[i].style.color = col;
        }
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
