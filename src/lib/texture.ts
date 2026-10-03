// The water texture from Subliminal-Labs/hiring (src/render.ts, written by Jerry Xiao),
// copied verbatim at his request - "the exact same water effect texture". The constants,
// hash2, prepareTexture and texAt below are hiring's own code unchanged (render.ts
// :93-118, :130-135, :339-440); only the closure state they read is declared at module
// level here, and fillTones() is hiring's frame-loop tone lookup (:634-640) as a function.
// Pure math, no DOM: the browser pond (web/dom/pond.ts) and the SSH pond (tui/app.tsx
// KoiPond) both fill one tone per cell from it.

const SWIRL_FALLOFF = 2.2; // render.ts:91, read by texAt's intro-spin branch (spin is 0 here)
let cols = 0;
let rows = 0;
let texT = 0;
let texSpin = 0;
let texRowU = 1;
let texCx = 0;
let texCy = 0;
let texRmax = 1;
let seedI0 = 0;
let seedJ0 = 0;
let seedW = 0;
let seedXs = new Float64Array(0);
let seedYs = new Float64Array(0);
let colSq = new Float64Array(0);
let colWuB = new Float64Array(0);
let colWvA = new Float64Array(0);
let rowWuA = new Float64Array(0);
let rowWvB = new Float64Array(0);

// Water texture: the web of light on the floor of a pool, covering the whole pond. It is
// glyphs and nothing else — no canvas, no fill — so the pond shows through by
// construction. The shape is a CELLULAR web: light runs along the boundaries between
// cells of a jittered, slowly drifting seed lattice (the distance to the boundary is
// half of F2 - F1, the two nearest seeds), so strands meet at junctions and enclose
// blobs, the way the reference does. The sample point is domain-warped by two sine
// octaves first, which bends every boundary into a curve instead of a straight bisector.
// Each cell's tone is its distance to the nearest strand, in cells: strand, edge, halo,
// then the ground of the water. Drifts slowly and never wraps.
const TEX_CELL = 26; // web cell size in col-widths (square on screen) — bigger = bigger blobs
const TEX_JITTER = 0.42; // seed wander off its lattice node, in cell sizes
const TEX_WARP_A = 7.0; // coarse warp amplitude, col-widths — bends the boundaries hard
const TEX_WARP_L = 15; // ...over this wavelength
const TEX_WARP_B = 3.0; // fine warp amplitude — the small wobble along a boundary
const TEX_WARP_L2 = 5.5;
// the tone boundaries are roughened by a slow ripple on the distance, so a halo does not
// end on a clean line but frays in and out like the reference
const TEX_FRAY = 1.6; // amplitude of that ripple, in cells
export const TEX_CYCLE_MS = 60000; // 2pi of phase per cycle — the drift speed
const TEX_SQUASH = 0.9; // mild sideways elongation of the cells
// tone cutoffs: distance to the nearest strand, in cells — x, +, ;, then : for the rest
const TEX_BANDS = [0.7, 2.0, 5.5];
// one glyph per tone, brightest first: strand, edge, halo, ground
export const TEX_CH = ["x", "+", ";", ":"];
// shades indexed by light level, so ground first
export const TEX_HEX = ["#181818", "#242424", "#343434", "#4c4c4c"];

// one stable pseudo-random number per lattice node, so a seed keeps its own drift phase
// across frames and resizes without a stored table
function hash2(i: number, j: number): number {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// Texture for one frame, sampled in screen-space col-widths (a row is LINE_H/cw of
// them) so the patches are round on screen. While the page is still swirling in, the
// sample point is spun about the centre — hardest at the middle, dying off outward and
// with time — so the water visibly rotates out of the centre and settles as the reveal
// completes.
//
// A cell's distance to the web is: warp the sample point by two sine octaves, find the
// two nearest seeds of the 3x3 lattice neighbourhood, and take half their difference
// (the boundary between cells of the jittered lattice), then fray it. Everything that
// depends on one thing only is computed here once a frame: each seed once per lattice
// node instead of up to nine times per cell, and, outside the spin, each warp term
// once per row or column. texAt() does the rest per cell. Hoisting changes no
// arithmetic and no order of operations, so every value is bit for bit what a full
// per-cell evaluation gives.
function prepareTexture(t: number, spin: number, rowU: number, cx: number, cy: number, rmax: number): void {
  texT = t;
  texSpin = spin;
  texRowU = rowU;
  texCx = cx;
  texCy = cy;
  texRmax = rmax;
  // every node a sample can reach: samples sit within rmax of the centre (spun or
  // not), the warp moves them by at most TEX_WARP_A + TEX_WARP_B, and each reads its
  // node's neighbours — two nodes of margin covers both that and rounding
  const reach = TEX_WARP_A + TEX_WARP_B;
  seedI0 = Math.floor(((cx - rmax) * TEX_SQUASH - reach) / TEX_CELL) - 2;
  seedJ0 = Math.floor((cy - rmax - reach) / TEX_CELL) - 2;
  seedW = Math.floor(((cx + rmax) * TEX_SQUASH + reach) / TEX_CELL) + 2 - seedI0 + 1;
  const seedH = Math.floor((cy + rmax + reach) / TEX_CELL) + 2 - seedJ0 + 1;
  if (seedXs.length !== seedW * seedH) {
    seedXs = new Float64Array(seedW * seedH);
    seedYs = new Float64Array(seedW * seedH);
  }
  for (let k = 0; k < seedW * seedH; k += 1) {
    const i = seedI0 + (k % seedW);
    const j = seedJ0 + Math.floor(k / seedW);
    const h = hash2(i, j) * 6.2832;
    seedXs[k] = (i + 0.5 + TEX_JITTER * Math.sin(t * 0.9 + h)) * TEX_CELL;
    seedYs[k] = (j + 0.5 + TEX_JITTER * Math.cos(t * 0.7 + h * 1.7)) * TEX_CELL;
  }
  if (spin > 0) return; // spun samples move per cell: texAt warps them itself
  if (colSq.length !== cols) {
    colSq = new Float64Array(cols);
    colWuB = new Float64Array(cols);
    colWvA = new Float64Array(cols);
  }
  if (rowWuA.length !== rows) {
    rowWuA = new Float64Array(rows);
    rowWvB = new Float64Array(rows);
  }
  for (let x = 0; x < cols; x += 1) {
    const u = x + 1 - 0.5;
    colSq[x] = u * TEX_SQUASH;
    colWuB[x] = TEX_WARP_B * Math.sin(u / TEX_WARP_L2 - t * 0.6);
    colWvA[x] = TEX_WARP_A * Math.cos(u / TEX_WARP_L + t * 0.8);
  }
  for (let y = 0; y < rows; y += 1) {
    const v = (y + 1 - 0.5) * rowU;
    rowWuA[y] = TEX_WARP_A * Math.sin(v / TEX_WARP_L + t);
    rowWvB[y] = TEX_WARP_B * Math.cos(v / TEX_WARP_L2 + t * 1.1);
  }
}

// distance from cell (x, y) to the nearest web strand, in col-widths
function texAt(x: number, y: number): number {
  const t = texT;
  let u = x + 1 - 0.5;
  let v = (y + 1 - 0.5) * texRowU;
  let wu: number;
  let wv: number;
  if (texSpin > 0) {
    const dx = u - texCx;
    const dy = v - texCy;
    const rr = Math.sqrt(dx * dx + dy * dy);
    const a = Math.atan2(dy, dx) + texSpin * Math.exp((-rr / texRmax) * SWIRL_FALLOFF);
    u = texCx + Math.cos(a) * rr;
    v = texCy + Math.sin(a) * rr;
    wu = u * TEX_SQUASH + TEX_WARP_A * Math.sin(v / TEX_WARP_L + t) + TEX_WARP_B * Math.sin(u / TEX_WARP_L2 - t * 0.6);
    wv = v + TEX_WARP_A * Math.cos(u / TEX_WARP_L + t * 0.8) + TEX_WARP_B * Math.cos(v / TEX_WARP_L2 + t * 1.1);
  } else {
    wu = colSq[x] + rowWuA[y] + colWuB[x];
    wv = v + colWvA[x] + rowWvB[y];
  }
  const ci = Math.floor(wu / TEX_CELL);
  const cj = Math.floor(wv / TEX_CELL);
  let d1 = Infinity;
  let d2 = Infinity;
  for (let j = cj - 1; j <= cj + 1; j += 1) {
    for (let i = ci - 1; i <= ci + 1; i += 1) {
      const k = (j - seedJ0) * seedW + (i - seedI0);
      const sx = seedXs[k];
      const sy = seedYs[k];
      const dd = (sx - wu) * (sx - wu) + (sy - wv) * (sy - wv);
      if (dd < d1) {
        d2 = d1;
        d1 = dd;
      } else if (dd < d2) d2 = dd;
    }
  }
  const fray = TEX_FRAY * Math.sin(u * 0.61 + v * 0.23 + t * 1.3) * Math.cos(v * 0.47 - u * 0.19 - t * 0.9);
  return (Math.sqrt(d2) - Math.sqrt(d1)) * 0.5 + fray;
}

/** hiring's phase for a frame: one slow, ever-growing angle; frozen under reduced motion. */
export function texturePhase(now: number, reduced: boolean): number {
  return reduced ? 1.7 : (now / TEX_CYCLE_MS) * Math.PI * 2;
}

/** One tone per cell (0 strand, 1 edge, 2 halo, 3 ground) for a `c` x `r` grid at phase
 *  `t`; `rowU` is one row's height in column widths. Colour a tone with TEX_HEX[3 - tone]
 *  (hiring indexes its shades by light level) and draw it as TEX_CH[tone]. */
export function fillTones(out: Uint8Array, c: number, r: number, rowU: number, t: number): void {
  cols = c;
  rows = r;
  const scx = cols * 0.5;
  const scy = rows * 0.5 * rowU;
  prepareTexture(t, 0, rowU, scx, scy, Math.sqrt(scx * scx + scy * scy));
  for (let y = 0; y < rows; y += 1)
    for (let x = 0; x < cols; x += 1) {
      // rounded to float32, the precision hiring's band edges were tuned at
      const dist = Math.fround(texAt(x, y));
      out[y * cols + x] = dist < TEX_BANDS[0] ? 0 : dist < TEX_BANDS[1] ? 1 : dist < TEX_BANDS[2] ? 2 : 3;
    }
}

// Copy claims its line, as on the hiring page ("a koi fin or a ripple glyph landing between
// two words reads as a typo"): the texture stays out of any gap of up to COPY_GAP cells
// between inked cells on a row - word spacing, padded columns such as "name ...  '26" - and
// out of COPY_PAD cells either side. Wider gaps (between page columns) keep their water.
export const COPY_GAP = 24;
export const COPY_PAD = 2;
