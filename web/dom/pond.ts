// Koi pond for the DOM app: the same ascii-koi KoiSim as the server TUI, painted as glyphs on the same
// cell grid as the app (same font and line boxes) into ONE canvas behind #root. Text rows paint
// their opaque PANEL strips over it exactly like the TUI's cell buffers, so koi and ripples
// flow through every gap the content leaves, in one medium. A cell is a pre-rendered glyph
// sprite blitted into an ImageData; only cells that changed are touched, so a frame costs what
// moved, not the pixel count (the first version was a DOM span per cell: 50k nodes at 4K).
// Cell metrics come from metrics.ts, so this grid and the DOM text grid are identical by
// construction. (web/pond.ts still serves the legacy xterm page until cutover.)
import { KoiSim, PAL_HEX, CP_FULL, CP_HALF, CP_EYE, C_EYE } from "ascii-koi";
import { WATER_CP, WATER_CREST_HEX, WATER_TROUGH_HEX, waterBucket, POND_BG_HEX, MOVE_AMP, DOWN_AMP } from "ascii-pond";
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

// one opaque sprite (RGBA words) per glyph/colour the pond draws, indexed by the ids above
function makeSprites(w: number, h: number, scale: number): Uint32Array[] {
  const out: Uint32Array[] = [];
  const add = (id: number, ch: string, color: string) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) return;
    g.fillStyle = POND_BG_HEX; // opaque: blitting a sprite over a cell replaces it
    g.fillRect(0, 0, w, h);
    g.scale(scale, scale);
    g.font = FONT;
    g.fillStyle = tone(color);
    g.textBaseline = "alphabetic";
    const fm = g.measureText("M");
    const asc = fm.fontBoundingBoxAscent ?? FONT_SIZE * 0.8;
    const desc = fm.fontBoundingBoxDescent ?? FONT_SIZE * 0.2;
    g.fillText(ch, 0, (LINE_H - (asc + desc)) / 2 + asc); // centred in the line box like DOM text
    out[id] = new Uint32Array(g.getImageData(0, 0, w, h).data.buffer);
  };
  TEX_CH.forEach((ch, t) => add(texId + t, ch, TEX_HEX[3 - t])); // hiring indexes its shades by light level
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
  return out;
}

// sprite id for a cell's koi pixels (top/bottom half-block palette indices) or water height
// `v`; 0 when it is calm open water
function pondSprite(top: number, bot: number, v: number): number {
  if (top || bot) {
    const idx = top || bot;
    return idx === C_EYE ? eyeId : (top && bot ? fullId : halfId) + idx;
  }
  const bkt = waterBucket(v < 0 ? -v : v);
  return bkt ? (v > 0 ? crestId : troughId) + bkt : 0;
}

function blit(dst: Uint32Array, dstW: number, spr: Uint32Array, sprW: number, x: number, y: number, w: number, h: number): void {
  for (let r = 0, s = 0, d = y * dstW + x; r < h; r += 1, s += sprW, d += dstW) for (let c = 0; c < w; c += 1) dst[d + c] = spr[s + c];
}

// The water texture's tone per cell. It drifts a full turn per minute (its fastest feature moves
// ~1 cell a second), so a refresh every 100ms looks identical to every frame, and so does one
// every cells/250 ms on a big grid (205ms at 4K); under reduced motion it is one still frame. A
// pass over a 4K grid costs ~10ms, so it is spread over TONE_BANDS frames (one phase per pass,
// so no seams) instead of one long frame ten times a second.
class WaterTexture {
  tones = new Uint8Array(0);
  private at = -1; // when the current (or last) pass began
  private row = 0; // next row of the pass in progress
  private phase = 0;
  private first = true;
  constructor(private reduced: boolean) {}
  advance(now: number, cols: number, rows: number, rowU: number): void {
    if (this.tones.length !== cols * rows) {
      this.tones = new Uint8Array(cols * rows);
      this.row = rows;
      this.at = -1;
    }
    if (this.row >= rows && (this.at < 0 || (!this.reduced && now - this.at >= Math.max(100, (cols * rows) / 250)))) {
      this.row = 0;
      this.phase = texturePhase(now, this.reduced);
      this.first = this.at < 0;
      this.at = now;
    }
    if (this.row >= rows) return;
    const to = this.first ? rows : Math.min(rows, this.row + Math.ceil(rows / TONE_BANDS)); // the first pass is not spread: the texture should not fade in
    fillTones(this.tones, cols, rows, rowU, this.phase, this.row, to);
    this.row = to;
  }
}

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
  let sim = new KoiSim(cols, rows, cols < 64 ? 0.5 : 1);
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
    sim = new KoiSim(cols, rows, cols < 64 ? 0.5 : 1);
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
    spriteW = Math.ceil(cellW * scale) + 1;
    sprites = makeSprites(spriteW, Math.ceil(LINE_H * scale) + 1, scale);
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

  // rAF loop — pauses automatically in background tabs; the pond clamps deltaMs at 100ms
  let last = performance.now();
  const texture = new WaterTexture(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  function frame(now: number) {
    sim.step(now - last);
    last = now;
    // re-measure occupancy at frame start (layout is clean before we paint);
    // the once-a-second fallback catches geometry drift no mutation reports (zoom, DPR)
    if ((maskDirty && now - maskAt >= MASK_MS) || now - maskAt >= 1000) {
      rebuildMask();
      maskDirty = false;
      maskAt = now;
    }
    const buf = sim.px;
    const field = sim.field;
    const PW = sim.PW;
    const W = sim.W;
    const drawCols = Math.min(cols, W);
    const drawRows = Math.min(rows, sim.H);
    const m = getMetrics();
    texture.advance(now, cols, rows, m.lh / m.cw);
    if (m.cw !== cellW || scale !== pickScale()) layout(); // late font load or zoom changed the cell
    const cwPx = cellW * scale;
    const lhPx = LINE_H * scale;
    for (let y = 0; y < drawRows; y += 1) {
      const top0 = 2 * y * PW;
      const rowOff = y * cols;
      const py0 = Math.round(y * lhPx);
      const ph = Math.round((y + 1) * lhPx) - py0;
      const calm = y >= CHROME_ROWS && y < drawRows - CHROME_ROWS; // calm water shows the texture, except in the header and footer rows
      let dirtyMin = Infinity;
      let dirtyMax = 0;
      for (let x = 0; x < drawCols; x += 1) {
        const i = rowOff + x;
        // a cell owned by app content holds no pond glyph: a terminal cell holds only one
        let id = mask[i] ? 0 : pondSprite(buf[top0 + x], buf[top0 + PW + x], field[y * W + x]);
        if (id === 0 && calm && !mask[i]) id = texId + texture.tones[i];
        if (shown[i] === id) continue;
        shown[i] = id;
        const px0 = Math.round(x * cwPx);
        const pw = Math.round((x + 1) * cwPx) - px0;
        blit(pixels, canvasW, sprites[id], spriteW, px0, py0, pw, ph);
        if (px0 < dirtyMin) dirtyMin = px0;
        if (px0 + pw > dirtyMax) dirtyMax = px0 + pw;
      }
      if (dirtyMax > 0) ctx.putImageData(img, 0, 0, dirtyMin, py0, dirtyMax - dirtyMin, ph); // one upload per changed row span
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
