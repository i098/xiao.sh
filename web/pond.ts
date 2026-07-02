// Browser-side koi pond: runs the SAME PondSim as the server TUI (src/lib/pond.ts) on a
// canvas behind a transparent xterm, so ripples/koi react to the cursor with zero network
// latency and the WS stream carries only text diffs. Served bundled as /pond.js.
// Relative import (not @/lib) so Bun.build resolves it without tsconfig paths.
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
} from "../src/lib/pond";

type XTermLike = {
  cols: number;
  rows: number;
  options: { fontSize?: number; fontFamily?: string };
  onResize(cb: (d: { cols: number; rows: number }) => void): void;
  _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } };
};

const WATER_CH = WATER_CP.map((c) => String.fromCharCode(c));
const FULL_CH = String.fromCharCode(CP_FULL);
const HALF_CH = String.fromCharCode(CP_HALF);
const EYE_CH = String.fromCharCode(CP_EYE);

function start() {
  const term = (window as unknown as { __term?: XTermLike }).__term;
  const app = document.getElementById("app");
  if (!term || !app) return; // page without the terminal — nothing to draw

  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.pointerEvents = "none"; // input flows to xterm; we listen on #app
  app.insertBefore(canvas, app.firstChild); // behind the .xterm element, inside the CRT filter
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // cell metrics from xterm's renderer (internal but stable on the pinned 5.5.0);
  // falls back to measuring the rendered screen element.
  function cellSize(): { w: number; h: number } {
    const c = term!._core?._renderService?.dimensions?.css?.cell;
    if (c && c.width > 0 && c.height > 0) return { w: c.width, h: c.height };
    const r = document.querySelector(".xterm-screen")?.getBoundingClientRect();
    if (r && r.width > 0 && term!.cols > 0) return { w: r.width / term!.cols, h: r.height / term!.rows };
    return { w: 8, h: 16 }; // pre-render fallback; the layout guard corrects it
  }

  let sim = new PondSim(term.cols, term.rows, term.cols < 64 ? 0.5 : 1);
  let cw = 8;
  let ch = 16;

  // size/position the canvas over the xterm cell grid (does NOT reset the sim)
  function layout() {
    const size = cellSize();
    cw = size.w;
    ch = size.h;
    const screen = document.querySelector(".xterm-screen")?.getBoundingClientRect();
    const box = app!.getBoundingClientRect();
    canvas.style.left = `${screen ? screen.left - box.left : 0}px`;
    canvas.style.top = `${screen ? screen.top - box.top : 0}px`;
    const cssW = cw * term!.cols;
    const cssH = ch * term!.rows;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    // same font stack + size as the xterm config so glyphs match the text layer
    ctx!.font = `${term!.options.fontSize ?? 14}px ${term!.options.fontFamily ?? "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"}`;
    ctx!.textAlign = "center";
    ctx!.textBaseline = "middle";
  }

  function rebuild() {
    sim = new PondSim(term!.cols, term!.rows, term!.cols < 64 ? 0.5 : 1); // koi swim back in from the edges
    layout();
  }
  term.onResize(rebuild);
  window.addEventListener("resize", layout);
  layout();

  // pointer → ripples, locally. Gate splashes on cell change so the splash rate matches
  // what the server used to see (one SGR report per cell crossing, halved).
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
  // so resuming never explodes the wave field.
  let last = performance.now();
  let frames = 0;
  function frame(now: number) {
    sim.step(now - last);
    last = now;
    // once a second, catch late font loads / zoom / DPR changes without resetting the sim
    if (frames++ % 60 === 0) {
      const s = cellSize();
      if (Math.abs(s.w - cw) > 0.5 || Math.abs(s.h - ch) > 0.5) layout();
    }
    const cols = Math.min(term!.cols, sim.W);
    const rows = Math.min(term!.rows, sim.H);
    ctx!.fillStyle = POND_BG_HEX;
    ctx!.fillRect(0, 0, cw * term!.cols, ch * term!.rows);
    let fill = POND_BG_HEX;
    const px = sim.px;
    const field = sim.field;
    const W = sim.W;
    const PW = sim.PW;
    for (let y = 0; y < rows; y += 1) {
      const top0 = 2 * y * PW;
      const bot0 = top0 + PW;
      const cy = y * ch + ch / 2;
      for (let x = 0; x < cols; x += 1) {
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

start();
