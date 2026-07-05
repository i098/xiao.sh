// Koi pond canvas for the DOM app: same PondSim as the server TUI, drawn behind the
// transparent text layer. Fork of web/pond.ts with the xterm coupling removed — cell
// metrics come from metrics.ts, so the canvas grid and the DOM text grid are identical
// by construction. (web/pond.ts still serves the xterm page until cutover.)
import {
  PondSim,
  PAL_HEX,
  POND_BG_HEX,
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

const WATER_CH = WATER_CP.map((c) => String.fromCharCode(c));
const FULL_CH = String.fromCharCode(CP_FULL);
const HALF_CH = String.fromCharCode(CP_HALF);
const EYE_CH = String.fromCharCode(CP_EYE);

export function startPond(app: HTMLElement): void {
  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.pointerEvents = "none"; // input flows to the app; we listen on the container
  app.insertBefore(canvas, app.firstChild); // behind #root, inside the CRT filter
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  let { cw, lh: ch, cols, rows } = getMetrics();
  let sim = new PondSim(cols, rows, cols < 64 ? 0.5 : 1);

  // size/position the canvas over the cell grid (does NOT reset the sim)
  function layout() {
    const m = getMetrics();
    cw = m.cw;
    ch = m.lh;
    const cssW = cw * m.cols;
    const cssH = ch * m.rows;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx!.font = FONT;
    ctx!.textAlign = "center";
    ctx!.textBaseline = "middle";
  }

  onMetrics(() => {
    const m = getMetrics();
    if (m.cols !== cols || m.rows !== rows) {
      cols = m.cols;
      rows = m.rows;
      sim = new PondSim(cols, rows, cols < 64 ? 0.5 : 1); // koi swim back in from the edges
    }
    layout();
  });
  window.addEventListener("resize", layout);
  layout();

  // pointer → ripples, locally. Gate splashes on cell change so the splash rate stays sane.
  let lastCellX = -1;
  let lastCellY = -1;
  let moveN = 0;
  function cellOf(e: PointerEvent): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: Math.floor((e.clientX - r.left) / cw), y: Math.floor((e.clientY - r.top) / ch) };
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

  // rAF loop — pauses automatically in background tabs; PondSim clamps deltaMs to 100ms
  let last = performance.now();
  let frames = 0;
  function frame(now: number) {
    sim.step(now - last);
    last = now;
    // once a second, catch late font loads / zoom / DPR changes without resetting the sim
    if (frames++ % 60 === 0) {
      const m = getMetrics();
      if (Math.abs(m.cw - cw) > 0.5 || Math.abs(m.lh - ch) > 0.5) layout();
    }
    const drawCols = Math.min(cols, sim.W);
    const drawRows = Math.min(rows, sim.H);
    ctx!.fillStyle = POND_BG_HEX;
    ctx!.fillRect(0, 0, cw * cols, ch * rows);
    let fill = POND_BG_HEX;
    const px = sim.px;
    const field = sim.field;
    const W = sim.W;
    const PW = sim.PW;
    for (let y = 0; y < drawRows; y += 1) {
      const top0 = 2 * y * PW;
      const bot0 = top0 + PW;
      const cy = y * ch + ch / 2;
      for (let x = 0; x < drawCols; x += 1) {
        const top = px[top0 + x];
        const bot = px[bot0 + x];
        let glyph: string;
        let color: string;
        if (top || bot) {
          const idx = top || bot;
          glyph = idx === C_EYE ? EYE_CH : top && bot ? FULL_CH : HALF_CH;
          color = PAL_HEX[idx];
        } else {
          const v = field[y * W + x];
          const bkt = waterBucket(v < 0 ? -v : v);
          if (bkt === 0) continue; // calm water stays plain background
          glyph = WATER_CH[bkt];
          color = (v > 0 ? WATER_CREST_HEX : WATER_TROUGH_HEX)[bkt];
        }
        if (color !== fill) {
          ctx!.fillStyle = color;
          fill = color;
        }
        ctx!.fillText(glyph, x * cw + cw / 2, cy);
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
