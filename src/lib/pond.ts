// Koi-pond simulation, shared verbatim between the server TUI (opentui composite in
// tui/app.tsx) and the browser canvas (web/pond.ts). Browser-safe: pure math + typed
// arrays, no bun/node/opentui imports. Colors live here as HEX — each renderer converts
// once to its own format (opentui u16 quads / canvas fillStyle).

// water surface: amplitude bucket -> glyph codepoint; color by intensity AND sign
// (crest = bright cyan, trough = deep blue) for clear wave color contrast.
export const WATER_CP = [0x20, 0xb7 /*·*/, 0x2d9 /*˙*/, 0x7e /*~*/, 0x2248 /*≈*/];
export const WATER_CREST_HEX = ["#0e2329", "#2f6b7a", "#52a0b6", "#86d6ec", "#cdf2ff"];
export const WATER_TROUGH_HEX = ["#0e2329", "#1d3c55", "#274f72", "#2c5f8c", "#356fa6"];
// matches the terminal bg (deep green) so the pond stays seamless — also the PANEL
// strip color behind every text row in the TUI.
export const POND_BG_HEX = "#030c0d";

// koi/lily palette — pixel buffer stores palette indices (0 = transparent)
export const C_WHITE = 1; // body base
export const C_FIN = 2;
export const C_ORANGE = 3;
export const C_RED = 4;
export const C_EYE = 5;
export const C_SUMI = 6; // Sanke's small black markings — dark slate
export const C_PAD = 7;
export const C_PETAL = 8;
export const C_FLOWER = 9;
export const PAL_HEX = [
  "#000000", // index 0 = transparent, never drawn
  "#eef2f5",
  "#cdd6dc",
  "#ff8a3d",
  "#d94f28",
  "#0c1016",
  "#333c47",
  "#3f6e3a",
  "#f3a8c8",
  "#f2d36b",
];
// koi rendered as ascii glyphs (not solid blocks), shaded by body coverage
export const CP_FULL = 0x23; // '#' both pixels covered
export const CP_HALF = 0x2a; // '*'
export const CP_EYE = 0x2022; // '•'
const N_COILS = 12;
const COIL_SP = 3.0; // px between body coils (shorter body = less snake-like)
const MAX_BEND = 0.22; // max bend per joint (rad) — keeps the body fish-stiff, not snake-curly

// cursor splash tuning, shared so browser ripples feel identical to the old server ones
export const MOVE_AMP = 2.2;
export const DOWN_AMP = 6;
export const SPLASH_CAP = 64;

// wave amplitude -> glyph bucket (0 = calm/space)
export function waterBucket(a: number): number {
  return a < 0.07 ? 0 : a > 0.6 ? 4 : a > 0.32 ? 3 : a > 0.16 ? 2 : 1;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

// body width profile: slim koi (tapered head/tail), scaled per fish
function coilRadius(i: number, size = 1) {
  const t = i / (N_COILS - 1);
  return (1.0 + 3.7 * Math.sin(t * Math.PI) + (t < 0.16 ? 0.8 : 0)) * size;
}
// a blotch: which spine coil, palette color, size ratio of the body radius, sideways offset
type Blotch = { i: number; col: number; dr: number; off: number };
// one koi variety: body base color, fin color, and its overlaid blotches
type KoiVariety = { name: string; base: number; fin: number; blotches: Blotch[] };
const KOI_VARIETIES: KoiVariety[] = [
  // Kōhaku — white body, large red/orange markings
  {
    name: "kohaku",
    base: C_WHITE,
    fin: C_FIN,
    blotches: [
      { i: 3, col: C_RED, dr: 0.95, off: -0.2 },
      { i: 6, col: C_ORANGE, dr: 0.8, off: 0.3 },
      { i: 9, col: C_RED, dr: 0.7, off: -0.3 },
    ],
  },
  // Sanke — white base, red plus small black markings
  {
    name: "sanke",
    base: C_WHITE,
    fin: C_FIN,
    blotches: [
      { i: 3, col: C_RED, dr: 0.9, off: -0.15 },
      { i: 6, col: C_RED, dr: 0.7, off: 0.35 },
      { i: 5, col: C_SUMI, dr: 0.42, off: -0.55 },
      { i: 8, col: C_SUMI, dr: 0.36, off: 0.45 },
    ],
  },
];

// lily pads (fractions of pond w/h, radius px) — drawn above koi, below text.
// each has a wedge slice removed (notch center angle + half-width); one bears a flower.
const LILY_PADS = [
  { fx: 0.86, fy: 0.2, r: 10, notch: 2.4, notchW: 0.4, flower: true }, // top-right (acute slice)
  { fx: 0.88, fy: 0.82, r: 11, notch: -2.3, notchW: 0.45, flower: false }, // bottom-right
  { fx: 0.12, fy: 0.84, r: 8, notch: -0.8, notchW: 0.35, flower: false }, // bottom-left
];

type KoiState = {
  s: number;
  spd: number;
  size: number;
  cx: number;
  cy: number;
  ax: number;
  ay: number;
  ph: number;
  variety: KoiVariety;
  spine: { x: number; y: number }[];
  ribbon: { x: number; y: number }[]; // tail streamer follow-chain, anchored at the fin tip
  rest: number; // ms of loitering left (0 = swimming): real koi hover in place sometimes
  nextRest: number; // ms until the next rest — staggered so the koi don't sync up
};

// Wave-propagation hot loop. Plain JS: the JIT vectorises this tight typed-array loop.
// Writes the next field into `prev` from `cur`'s neighbours; caller swaps.
// Anisotropic: horizontal coupling 4x vertical (terminal cells are ~2:1 tall) so a
// ripple renders as a circle on screen instead of a vertical ellipse.
function waveStep(cur: Float32Array, prev: Float32Array, w: number, h: number, damp: number): void {
  for (let y = 1; y < h - 1; y += 1) {
    const row = y * w;
    for (let x = 1; x < w - 1; x += 1) {
      const i = row + x;
      prev[i] = (0.75 * cur[i] - prev[i] + 0.5 * (cur[i - 1] + cur[i + 1]) + 0.125 * (cur[i - w] + cur[i + w])) * damp;
    }
  }
}

// pixel-raster helpers over the koi half-block buffer (palette indices, 0 = transparent)
function diskPx(buf: Uint8Array, pw: number, ph: number, cx: number, cy: number, r: number, col: number): void {
  const r2 = r * r;
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(ph - 1, Math.ceil(cy + r));
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(pw - 1, Math.ceil(cx + r));
  for (let yy = y0; yy <= y1; yy += 1)
    for (let xx = x0; xx <= x1; xx += 1) {
      const dx = xx - cx;
      const dy = yy - cy;
      if (dx * dx + dy * dy <= r2) buf[yy * pw + xx] = col;
    }
}
function triPx(
  buf: Uint8Array,
  pw: number,
  ph: number,
  ax2: number,
  ay2: number,
  bx2: number,
  by2: number,
  cx3: number,
  cy3: number,
  col: number,
): void {
  const minx = Math.max(0, Math.floor(Math.min(ax2, bx2, cx3)));
  const maxx = Math.min(pw - 1, Math.ceil(Math.max(ax2, bx2, cx3)));
  const miny = Math.max(0, Math.floor(Math.min(ay2, by2, cy3)));
  const maxy = Math.min(ph - 1, Math.ceil(Math.max(ay2, by2, cy3)));
  const den = (by2 - cy3) * (ax2 - cx3) + (cx3 - bx2) * (ay2 - cy3);
  if (Math.abs(den) < 1e-6) return;
  for (let yy = miny; yy <= maxy; yy += 1)
    for (let xx = minx; xx <= maxx; xx += 1) {
      const w1 = ((by2 - cy3) * (xx - cx3) + (cx3 - bx2) * (yy - cy3)) / den;
      const w2 = ((cy3 - ay2) * (xx - cx3) + (ax2 - cx3) * (yy - cy3)) / den;
      if (w1 >= 0 && w2 >= 0 && w1 + w2 <= 1) buf[yy * pw + xx] = col;
    }
}
function setPx(buf: Uint8Array, pw: number, ph: number, x: number, y: number, col: number): void {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi >= 0 && yi >= 0 && xi < pw && yi < ph) buf[yi * pw + xi] = col;
}

// Full pond state machine: koi swim in from the edges, flee the cursor; cursor/koi leave
// wave-sim ripples. Inputs are CELL-space (terminal cols/rows), matching the old
// mouseRef/splashRef contract; the y×2 half-block conversion happens internally.
// step() outputs: `px` (PW×PH palette indices, PH = rows*2) and `field` (W×H wave heights).
export class PondSim {
  readonly W: number;
  readonly H: number;
  readonly PW: number;
  readonly PH: number;
  readonly scale: number;
  mouse: { x: number; y: number } | null = null; // cell space
  readonly px: Uint8Array;
  private splashes: { x: number; y: number; amp: number }[] = [];
  private koi: KoiState[] = [];
  private hCur: Float32Array;
  private hPrev: Float32Array;
  private waveAcc = 0;

  constructor(cols: number, rows: number, scale = 1) {
    this.W = Math.max(10, cols);
    this.H = Math.max(6, rows);
    this.PW = this.W;
    this.PH = this.H * 2; // pixel rows (half-block)
    this.scale = scale;
    this.px = new Uint8Array(this.PW * this.PH);
    this.hCur = new Float32Array(this.W * this.H);
    this.hPrev = new Float32Array(this.W * this.H);
  }

  // wave heights, W×H cell space (post-swap current buffer)
  get field(): Float32Array {
    return this.hCur;
  }

  // queue a splash at cell coords; capped so a fast cursor can't stockpile energy
  splash(x: number, y: number, amp: number): void {
    if (this.splashes.length < SPLASH_CAP) this.splashes.push({ x, y, amp });
  }

  step(deltaMs: number): void {
    const { W, H, PW, PH, scale } = this;
    const margin = 12;
    // each koi swims its own wandering loop (own center / amplitude / phase / speed)
    function leadFor(k: KoiState, s: number) {
      return {
        x: clamp(k.cx + k.ax * Math.sin(s + k.ph) + k.ax * 0.33 * Math.sin(2.7 * s + k.ph + 1.3), margin, PW - margin),
        y: clamp(k.cy + k.ay * Math.cos(0.9 * s + k.ph) + k.ay * 0.42 * Math.sin(1.6 * s + k.ph + 0.5), margin, PH - margin),
      };
    }
    if (this.koi.length === 0) {
      const defs: Omit<KoiState, "s" | "spine" | "ribbon" | "rest" | "nextRest">[] = [
        { spd: 0.018, size: 1.0, cx: PW * 0.42, cy: PH * 0.5, ax: PW * 0.3, ay: PH * 0.26, ph: 0, variety: KOI_VARIETIES[0] },
        { spd: 0.023, size: 0.8, cx: PW * 0.6, cy: PH * 0.42, ax: PW * 0.24, ay: PH * 0.22, ph: 2.1, variety: KOI_VARIETIES[1] },
      ];
      this.koi = defs.map((d) => {
        const k: KoiState = { ...d, size: d.size * scale, s: d.ph, spine: [], ribbon: [], rest: 0, nextRest: 6000 + Math.random() * 14000 };
        // start just off a random edge, body trailing further off-screen → swims in
        const edge = Math.floor(Math.random() * 4);
        let hx = 0;
        let hy = 0;
        let dx = 0;
        let dy = 0;
        if (edge === 0) {
          hx = Math.random() * PW;
          hy = -3;
          dy = -1;
        } else if (edge === 1) {
          hx = Math.random() * PW;
          hy = PH + 3;
          dy = 1;
        } else if (edge === 2) {
          hx = -3;
          hy = Math.random() * PH;
          dx = -1;
        } else {
          hx = PW + 3;
          hy = Math.random() * PH;
          dx = 1;
        }
        k.spine = Array.from({ length: N_COILS }, (_, i) => ({ x: hx + dx * i * COIL_SP, y: hy + dy * i * COIL_SP }));
        k.ribbon = Array.from({ length: 12 }, (_, i) => ({
          x: hx + dx * (N_COILS + i) * COIL_SP,
          y: hy + dy * (N_COILS + i) * COIL_SP,
        }));
        return k;
      });
    }
    // koi kinematics run per frame; physics constants were tuned at a 33ms tick, so
    // `n` rescales the increments — 60fps doesn't double swim speed. The 100ms clamp
    // also makes background-tab rAF resumes graceful (no wave explosion).
    const n = Math.min(deltaMs, 100) / 33;
    const dtMs = Math.min(deltaMs, 100);
    const ease = 1 - Math.pow(0.84, n); // 0.16 per 33ms tick
    const m = this.mouse;
    for (const k of this.koi) {
      // rest state: real koi loiter. The lead point all but stops (s creeps at 15%, so
      // fins/tail keep a slow sway and the body drifts), then wandering resumes.
      if (k.rest > 0) {
        k.rest -= dtMs;
        k.s += k.spd * n * 0.15;
      } else {
        k.nextRest -= dtMs;
        if (k.nextRest <= 0) {
          k.rest = 2500 + Math.random() * 4000;
          k.nextRest = 9000 + Math.random() * 16000;
        }
        k.s += k.spd * n;
      }
      const target = leadFor(k, k.s);
      const head = k.spine[0];
      if (m) {
        const dx = head.x - m.x;
        const dy = head.y - m.y * 2;
        const d = Math.hypot(dx, dy);
        if (d < 24 && d > 0.001) {
          k.rest = 0; // startled — dart, don't loiter
          const f = (24 - d) * 0.5;
          target.x += (dx / d) * f;
          target.y += (dy / d) * f;
        }
      }
      // separation: steer away from the nearest part of every other koi
      for (const o of this.koi) {
        if (o === k || o.spine.length === 0) continue;
        let best = Infinity;
        let bx = 0;
        let by = 0;
        for (const sp of o.spine) {
          const dd = (head.x - sp.x) ** 2 + (head.y - sp.y) ** 2;
          if (dd < best) {
            best = dd;
            bx = sp.x;
            by = sp.y;
          }
        }
        const sd = Math.sqrt(best);
        const sr = 5 * k.size + 5 * o.size + 5;
        if (sd < sr && sd > 0.001) {
          const f = (sr - sd) * 0.9;
          target.x += ((head.x - bx) / sd) * f;
          target.y += ((head.y - by) / sd) * f;
        }
      }
      // ease toward target but cap speed → natural constant-glide swim-in from edges;
      // resting koi only drift (a startle above already cleared rest, so darts stay fast)
      const ex = (target.x - head.x) * ease;
      const ey = (target.y - head.y) * ease;
      const es = Math.hypot(ex, ey) || 1;
      const maxStep = (k.rest > 0 ? 0.3 : 1.1) * n;
      const stepScale = es > maxStep ? maxStep / es : 1;
      head.x += ex * stepScale;
      head.y += ey * stepScale;
      // follow chain with per-joint bend limit (fish-stiff, not snake-curly)
      for (let i = 1; i < N_COILS; i += 1) {
        const a = k.spine[i - 1];
        const b = k.spine[i];
        let ang = Math.atan2(b.y - a.y, b.x - a.x);
        if (i >= 2) {
          const p2 = k.spine[i - 2];
          const prevA = Math.atan2(a.y - p2.y, a.x - p2.x);
          let diff = ang - prevA;
          while (diff > Math.PI) diff -= 2 * Math.PI;
          while (diff < -Math.PI) diff += 2 * Math.PI;
          if (diff > MAX_BEND) ang = prevA + MAX_BEND;
          else if (diff < -MAX_BEND) ang = prevA - MAX_BEND;
        }
        b.x = a.x + Math.cos(ang) * COIL_SP;
        b.y = a.y + Math.sin(ang) * COIL_SP;
      }
    }
    // water height-field: wave propagation + damping (double-buffered) on a fixed
    // 30Hz clock — the stencil's wave speed and damping are per-step, so stepping
    // per frame would tie ripple physics to fps. 0.93 damping → tighter ripples.
    const splashAt = (x: number, y: number, amp: number) => {
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi < 1 || yi < 1 || xi >= W - 1 || yi >= H - 1) return;
      this.hCur[yi * W + xi] -= amp;
    };
    this.waveAcc += Math.min(deltaMs, 100);
    let steps = 0;
    while (this.waveAcc >= 33 && steps < 4) {
      this.waveAcc -= 33;
      steps += 1;
      const cur = this.hCur;
      const prev = this.hPrev;
      waveStep(cur, prev, W, H, 0.93);
      this.hCur = prev;
      this.hPrev = cur;
      // queued cursor splashes (fed from the mouse handlers)
      const q = this.splashes;
      for (let i = 0; i < q.length; i += 1) splashAt(q[i].x, q[i].y, q[i].amp);
      q.length = 0;
      // gentle koi wakes
      for (const k of this.koi) {
        splashAt(k.spine[0].x, k.spine[0].y / 2, 0.18);
        splashAt(k.spine[N_COILS - 1].x, k.spine[N_COILS - 1].y / 2, 0.12);
      }
    }
    if (this.waveAcc >= 33) this.waveAcc = 0; // stalled — drop the backlog

    // koi: rasterize the body chain into the pixel buffer (palette indices)
    const buf = this.px;
    buf.fill(0);
    const disk = (cx2: number, cy2: number, r: number, col: number) => diskPx(buf, PW, PH, cx2, cy2, r, col);
    const triFill = (ax2: number, ay2: number, bx2: number, by2: number, cx3: number, cy3: number, col: number) =>
      triPx(buf, PW, PH, ax2, ay2, bx2, by2, cx3, cy3, col);
    const setpx = (x: number, y: number, col: number) => setPx(buf, PW, PH, x, y, col);

    for (const k of this.koi) {
      const spine = k.spine;
      if (!spine.length) continue;
      const size = k.size;
      const v = k.variety;

      // body: variety base color + its overlaid blotches (no full-width stripes)
      for (let i = N_COILS - 1; i >= 0; i -= 1) disk(spine[i].x, spine[i].y, coilRadius(i, size), v.base);
      for (const b of v.blotches) {
        const c = spine[b.i];
        const cp = spine[b.i - 1];
        const dl = Math.hypot(c.x - cp.x, c.y - cp.y) || 1;
        const ppx = -(c.y - cp.y) / dl;
        const ppy = (c.x - cp.x) / dl;
        const r = coilRadius(b.i, size);
        disk(c.x + ppx * b.off * r, c.y + ppy * b.off * r, r * b.dr, b.col);
      }

      // tail: one flowing caudal fin — a single ribbon for most of its length that widens
      // toward the end, where a tiny triangular snip splits it into two short pointy tips.
      // The ribbon is a follow-chain anchored at the fin tip (same physics as the spine),
      // so it trails the tail's REAL motion — no independent oscillator that could swing
      // against the fish's whip. A small sway keeps it alive during straight glides.
      const t0 = spine[N_COILS - 1];
      const t1 = spine[N_COILS - 2];
      const tl = Math.hypot(t0.x - t1.x, t0.y - t1.y) || 1;
      const ux = (t0.x - t1.x) / tl; // backward, away from the head
      const uy = (t0.y - t1.y) / tl;
      const px = -uy; // lateral (perpendicular to the body axis)
      const py = ux;
      const bx0 = t0.x + ux * 1.6 * size;
      const by0 = t0.y + uy * 1.6 * size;
      const sway = Math.sin(k.s * 4) * 1.2 * size;
      const finLenT = 4 * size; // the solid root fin stays short
      const whiskLen = N_COILS * COIL_SP * 0.22 * size; // ribbon is a short accent, not a train
      const apx = bx0 + ux * finLenT + px * sway;
      const apy = by0 + uy * finLenT + py * sway;
      // peduncle: a filler disk so body → fin reads as one tapering mass, not a step
      disk(bx0 - ux * 0.8 * size, by0 - uy * 0.8 * size, 1.15 * size, v.base);
      triFill(bx0 + px * 1.3, by0 + py * 1.3, bx0 - px * 1.3, by0 - py * 1.3, apx, apy, v.base);
      const rib = k.ribbon;
      const seg = whiskLen / rib.length;
      const RIB_BEND = 0.35; // looser than the spine — silky, but never kinked
      let prevX = apx;
      let prevY = apy;
      let prevAng = Math.atan2(uy, ux);
      for (let i = 0; i < rib.length; i += 1) {
        const p = rib[i];
        let ang = p.x === prevX && p.y === prevY ? prevAng : Math.atan2(p.y - prevY, p.x - prevX);
        let diff = ang - prevAng;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        if (diff > RIB_BEND) ang = prevAng + RIB_BEND;
        else if (diff < -RIB_BEND) ang = prevAng - RIB_BEND;
        p.x = prevX + Math.cos(ang) * seg;
        p.y = prevY + Math.sin(ang) * seg;
        const f = (i + 1) / rib.length;
        const r = (0.85 + f * 1.0) * size; // thick enough at the root to flow out of the fin
        if (f <= 0.7) {
          disk(p.x, p.y, Math.max(0.35, r), v.fin); // one joined ribbon
        } else {
          // the snip: last stretch splits into two tips around a tiny triangular gap
          // (flare must outpace tip radius by >1px or the raster swallows the cut)
          const g = (f - 0.7) / 0.3;
          const off = (0.6 + g * 1.6) * size;
          const opx = -Math.sin(ang); // perpendicular to the local ribbon direction
          const opy = Math.cos(ang);
          disk(p.x + opx * off, p.y + opy * off, Math.max(0.35, r * 0.55), v.fin);
          disk(p.x - opx * off, p.y - opy * off, Math.max(0.35, r * 0.55), v.fin);
        }
        prevX = p.x;
        prevY = p.y;
        prevAng = ang;
      }

      // pectoral fins: triangles swept back toward the tail
      const mi = 3;
      const mc = spine[mi];
      const mp = spine[mi - 1];
      const ml = Math.hypot(mc.x - mp.x, mc.y - mp.y) || 1;
      const tx = (mc.x - mp.x) / ml;
      const ty = (mc.y - mp.y) / ml;
      const fpx = -ty;
      const fpy = tx;
      const flap = 1 + Math.sin(k.s * 5 + 1) * 0.35;
      const r0 = coilRadius(mi, size);
      const finLen = 6 * size;
      const finOut = 4.5 * flap * size;
      for (const side of [1, -1]) {
        const rfx = mc.x + fpx * side * r0 * 0.7 - tx * 2;
        const rfy = mc.y + fpy * side * r0 * 0.7 - ty * 2;
        const rbx = mc.x + fpx * side * r0 * 0.7;
        const rby = mc.y + fpy * side * r0 * 0.7;
        const tipx = mc.x + tx * finLen + fpx * side * (r0 + finOut);
        const tipy = mc.y + ty * finLen + fpy * side * (r0 + finOut);
        triFill(rfx, rfy, rbx, rby, tipx, tipy, v.fin);
      }

      // eyes near the head
      const h0 = spine[0];
      const h1 = spine[1];
      const hl = Math.hypot(h0.x - h1.x, h0.y - h1.y) || 1;
      const epx = -(h0.y - h1.y) / hl;
      const epy = (h0.x - h1.x) / hl;
      const eo = 1.7 * size;
      setpx(h0.x + epx * eo, h0.y + epy * eo, C_EYE);
      setpx(h0.x - epx * eo, h0.y - epy * eo, C_EYE);
    }

    // lily pads: drawn AFTER koi (so koi swim under them), gently bobbing, with a flower
    const padTime = this.koi[0]?.s ?? 0;
    LILY_PADS.forEach((p, i) => {
      const cxp = p.fx * PW;
      const cyp = p.fy * PH + Math.sin(padTime * 1.4 + i) * 0.35;
      // draw the pad as a disk MINUS the wedge — the notch is never painted, so koi
      // (drawn earlier) stay visible through the cut instead of being erased
      const r2 = p.r * p.r;
      const y0 = Math.max(0, Math.floor(cyp - p.r));
      const y1 = Math.min(PH - 1, Math.ceil(cyp + p.r));
      const x0 = Math.max(0, Math.floor(cxp - p.r));
      const x1 = Math.min(PW - 1, Math.ceil(cxp + p.r));
      for (let yy = y0; yy <= y1; yy += 1)
        for (let xx = x0; xx <= x1; xx += 1) {
          const dx = xx - cxp;
          const dy = yy - cyp;
          if (dx * dx + dy * dy > r2) continue;
          let diff = Math.atan2(dy, dx) - p.notch;
          while (diff > Math.PI) diff -= 2 * Math.PI;
          while (diff < -Math.PI) diff += 2 * Math.PI;
          if (Math.abs(diff) < p.notchW) continue; // skip the wedge → leave koi/water
          buf[yy * PW + xx] = C_PAD;
        }
      // flower on the one designated pad: 5 petals + center
      if (p.flower) {
        for (let k = 0; k < 5; k += 1) {
          const a = (k * 2 * Math.PI) / 5 - 1.2;
          disk(cxp + Math.cos(a) * 2.4, cyp + Math.sin(a) * 2.4, 1.4, C_PETAL);
        }
        disk(cxp, cyp, 1.3, C_FLOWER);
      }
    });
  }
}
