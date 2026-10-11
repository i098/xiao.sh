// Koi pond for the DOM app: same PondSim as the server TUI, painted as glyphs on the same
// cell grid as the app (same font and line boxes) into ONE canvas behind #root. Text rows paint
// their opaque PANEL strips over it exactly like the TUI's cell buffers, so koi and ripples
// flow through every gap the content leaves, in one medium. A cell is a pre-rendered glyph
// sprite blitted into an ImageData; only cells that changed are touched, so a frame costs what
// moved, not the pixel count (the first version was a DOM span per cell: 50k nodes at 4K).
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
  POND_BG_HEX,
  MOVE_AMP,
  DOWN_AMP,
} from "../../src/lib/pond";
import { tone } from "./tone";
import { FONT, FONT_SIZE, LINE_H, getMetrics, onMetrics } from "./metrics";
import { COPY_GAP, COPY_PAD, TEX_CH, TEX_HEX, fillTones, texturePhase } from "../../src/lib/texture";

// header (pad + title + rule) and footer (rule + nav + pad) rows stay texture-free
const CHROME_ROWS = 3;

const WATER_CH = WATER_CP.map((c) => String.fromCharCode(c)); // index 0 = " " (calm)
const FULL_CH = String.fromCharCode(CP_FULL);
const HALF_CH = String.fromCharCode(CP_HALF);
const EYE_CH = String.fromCharCode(CP_EYE);

// sprite ids: 0 = blank; each family below is indexed by tone / water bucket / palette index
const texId = 1; // + tone 0..3
const crestId = 5; // + bucket 1..4
const troughId = 10; // + bucket 1..4
const fullId = 15; // + palette index 1..9
const halfId = 25; // + palette index 1..9
const eyeId = 35;
const MASK_MS = 100; // the occupancy mask re-measures at most this often (it forces layout)
const TONE_BANDS = 6; // frames one texture pass is spread over

export function startPond(app: HTMLElement): void {
  // ONE canvas of glyph sprites, not a span per cell: at 4K the grid is ~50k cells, and a DOM
  // node each made every frame (and the browser's style/layout/paint) scale with pixel count.
  const layer = document.createElement("canvas");
  const ctx = layer.getContext("2d", { alpha: false }) as CanvasRenderingContext2D; // nothing but the page background lies beneath
  // input flows to the app; we listen on the container (same contract as before)
  layer.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;";
  app.insertBefore(layer, app.firstChild); // behind #root, inside the CRT filter

  // backing-store scale: the device pixel ratio, capped so the canvas stays ~16 megapixels
  const pickScale = () => Math.max(1, Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (window.innerWidth * window.innerHeight))));
  let cellW = 0;
  let scale = 1;
  // Cells are blitted by hand into one ImageData and uploaded per changed row span. A
  // drawImage per cell was the cost at 4K: tens of thousands of tiny canvas ops a frame.
  let sprites: Uint32Array[] = []; // opaque RGBA words, spriteW wide
  let spriteW = 0;
  let img: ImageData = new ImageData(1, 1);
  let pixels = new Uint32Array(img.data.buffer);
  let canvasW = 1;
  let { cols, rows } = getMetrics();
  let sim = new PondSim(cols, rows, cols < 64 ? 0.5 : 1);
  // which sprite each cell shows right now, so a frame only draws cells that changed
  let shown = new Uint16Array(0);
  // cell-exclusivity mask: a terminal cell holds ONE glyph, so cells occupied by app
  // text (or painted boxes/inputs) are off-limits to the pond — koi swim under content
  // and reappear, never double-striking a cell. Rebuilt from live DOM geometry.
  // 1 = inked by the app; 2 = the rest of a line of copy (see rebuildMask)
  let mask = new Uint8Array(0);
  let maskDirty = true;
  let maskAt = -Infinity;
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
    // inked glyphs claim their cells here; the spaces inside each line of copy are claimed
    // below, matching the TUI's CopyClearance pass
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
    // each line of copy claims its whole run, as on the hiring page: the gaps between its
    // words and padded columns (up to COPY_GAP cells; the left edge counts as copy, so the
    // gutter before indented text stays clear too) and COPY_PAD cells either side, so no
    // texture strand, ripple glyph or koi fin lands beside a word and reads as a typo or bullet
    for (let y = 0; y < rows; y += 1) {
      const row = y * cols;
      let last = -1; // the left edge
      for (let x = 0; x < cols; x += 1) {
        if (mask[row + x] !== 1) continue;
        for (let k = x - last - 1 <= COPY_GAP ? last + 1 : x; k < x; k += 1) mask[row + k] ||= 2;
        for (let k = Math.max(0, x - COPY_PAD); k <= Math.min(cols - 1, x + COPY_PAD); k += 1) mask[row + k] ||= 2;
        last = x;
      }
    }
  }
  // any DOM change under #root can move text; re-measure on the next frame. Typing
  // changes an input's value PROPERTY (no mutation record), so listen for it too.
  if (root) new MutationObserver(() => (maskDirty = true)).observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  app.addEventListener("input", () => (maskDirty = true), true);
  document.fonts?.ready?.then(() => (maskDirty = true)).catch(() => {});

  // (re)build for a new grid; a resize also resets the sim — koi swim back in from the
  // edges, which reads as the intentional intro (the TUI does the same on resize)
  function build() {
    const m = getMetrics();
    cols = m.cols;
    rows = m.rows;
    sim = new PondSim(cols, rows, cols < 64 ? 0.5 : 1);
    mask = new Uint8Array(cols * rows);
    maskDirty = true;
    layout();
  }
  // canvas size + glyph sprites for the current cell metrics and pixel ratio
  function layout() {
    cellW = getMetrics().cw;
    scale = pickScale();
    layer.width = Math.round(cols * cellW * scale);
    layer.height = Math.round(rows * LINE_H * scale);
    layer.style.width = `${cols * cellW}px`;
    layer.style.height = `${rows * LINE_H}px`;
    shown = new Uint16Array(cols * rows); // id 0 = blank, which the fill below paints
    sprites = [];
    spriteW = Math.ceil(cellW * scale) + 1;
    const spriteH = Math.ceil(LINE_H * scale) + 1;
    const add = (id: number, ch: string, color: string) => {
      const c = document.createElement("canvas");
      c.width = spriteW;
      c.height = spriteH;
      const g = c.getContext("2d", { willReadFrequently: true });
      if (!g) return;
      g.fillStyle = POND_BG_HEX; // opaque sprites: blitting one over a cell replaces it
      g.fillRect(0, 0, spriteW, spriteH);
      g.scale(scale, scale);
      g.font = FONT;
      g.fillStyle = tone(color);
      g.textBaseline = "alphabetic";
      const fm = g.measureText("M");
      const asc = fm.fontBoundingBoxAscent ?? FONT_SIZE * 0.8;
      const desc = fm.fontBoundingBoxDescent ?? FONT_SIZE * 0.2;
      g.fillText(ch, 0, (LINE_H - (asc + desc)) / 2 + asc); // centred in the line box like DOM text
      sprites[id] = new Uint32Array(g.getImageData(0, 0, spriteW, spriteH).data.buffer);
    };
    for (let t = 0; t < TEX_CH.length; t += 1) add(texId + t, TEX_CH[t], TEX_HEX[3 - t]); // hiring indexes its shades by light level
    for (let b = 1; b < WATER_CH.length; b += 1) {
      add(crestId + b, WATER_CH[b], WATER_CREST_HEX[b]);
      add(troughId + b, WATER_CH[b], WATER_TROUGH_HEX[b]);
    }
    for (let p = 1; p < PAL_HEX.length; p += 1) {
      if (p === C_EYE) continue;
      add(fullId + p, FULL_CH, PAL_HEX[p]);
      add(halfId + p, HALF_CH, PAL_HEX[p]);
    }
    add(eyeId, EYE_CH, PAL_HEX[C_EYE]);
    add(0, " ", POND_BG_HEX); // blank cell
    canvasW = layer.width;
    img = ctx.createImageData(canvasW, layer.height);
    pixels = new Uint32Array(img.data.buffer);
    pixels.fill(sprites[0][0]); // every cell starts blank
    ctx.putImageData(img, 0, 0);
  }
  build();
  onMetrics(build); // fires only when cols/rows change; glyph-width drift re-runs layout() in the frame loop

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
  let tones = new Uint8Array(0);
  let tonesAt = -1; // when the current (or last) texture pass began
  let passRow = 0;
  let passPhase = 0;
  let passFirst = true;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  function frame(now: number) {
    sim.step(now - last);
    last = now;
    // re-measure occupancy at frame start (layout is clean before our span writes);
    // the once-a-second fallback catches geometry drift no mutation reports (zoom, DPR)
    if (maskDirty && now - maskAt >= MASK_MS) {
      rebuildMask();
      maskDirty = false;
      maskAt = now;
    } else if (now - maskAt >= 1000) {
      rebuildMask();
      maskAt = now;
    }
    const buf = sim.px;
    const field = sim.field;
    const PW = sim.PW;
    const W = sim.W;
    const drawCols = Math.min(cols, sim.W);
    const drawRows = Math.min(rows, sim.H);
    // The texture drifts a full turn per minute (its fastest feature moves ~1 cell a second), so
    // a refresh every 100ms looks identical to every frame, and so does one every cells/250 ms
    // on a big grid (205ms at 4K); under reduced motion it is one still frame. A pass over a 4K grid costs
    // ~10ms, so it is spread over TONE_BANDS frames (one phase per pass, so no seams) instead
    // of one long frame ten times a second.
    if (tones.length !== cols * rows) {
      tones = new Uint8Array(cols * rows);
      passRow = rows;
      tonesAt = -1;
    }
    if (passRow >= rows && (tonesAt < 0 || (!reduced && now - tonesAt >= Math.max(100, (cols * rows) / 250)))) {
      passRow = 0;
      passPhase = texturePhase(now, reduced);
      passFirst = tonesAt < 0;
      tonesAt = now;
    }
    if (passRow < rows) {
      const to = passFirst ? rows : Math.min(rows, passRow + Math.ceil(rows / TONE_BANDS)); // the first pass is not spread: the texture should not fade in
      const m = getMetrics();
      fillTones(tones, cols, rows, m.lh / m.cw, passPhase, passRow, to);
      passRow = to;
    }
    const m = getMetrics();
    if (m.cw !== cellW || scale !== pickScale()) layout(); // late font load or zoom changed the cell
    const cwPx = cellW * scale;
    const lhPx = LINE_H * scale;
    for (let y = 0; y < drawRows; y += 1) {
      const top0 = 2 * y * PW;
      const bot0 = top0 + PW;
      const rowOff = y * cols;
      const py0 = Math.round(y * lhPx);
      const ph = Math.round((y + 1) * lhPx) - py0;
      let dirtyMin = Infinity;
      let dirtyMax = 0;
      for (let x = 0; x < drawCols; x += 1) {
        const i = rowOff + x;
        let id = 0; // 0 = blank cell
        // a cell owned by app content holds no pond glyph: a terminal cell holds only one
        if (!mask[i]) {
          const top = buf[top0 + x];
          const bot = buf[bot0 + x];
          if (top || bot) {
            const idx = top || bot;
            id = idx === C_EYE ? eyeId : (top && bot ? fullId : halfId) + idx;
          } else {
            const v = field[y * W + x];
            const bkt = waterBucket(v < 0 ? -v : v);
            if (bkt) id = (v > 0 ? crestId : troughId) + bkt;
            // calm water shows the texture, except in the header and footer rows
            else if (y >= CHROME_ROWS && y < drawRows - CHROME_ROWS) id = texId + tones[i];
          }
        }
        if (shown[i] === id) continue;
        shown[i] = id;
        const px0 = Math.round(x * cwPx);
        const pw = Math.round((x + 1) * cwPx) - px0;
        const spr = sprites[id];
        for (let r = 0, s = 0, d = py0 * canvasW + px0; r < ph; r += 1, s += spriteW, d += canvasW) for (let c = 0; c < pw; c += 1) pixels[d + c] = spr[s + c];
        if (px0 < dirtyMin) dirtyMin = px0;
        if (px0 + pw > dirtyMax) dirtyMax = px0 + pw;
      }
      if (dirtyMax > 0) ctx.putImageData(img, 0, 0, dirtyMin, py0, dirtyMax - dirtyMin, ph); // one upload per changed row span
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
