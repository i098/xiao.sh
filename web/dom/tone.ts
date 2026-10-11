// The page's colour grade, applied to colours instead of to pixels. It used to be
// `filter: brightness(1.08) saturate(1.18)` on the whole #app, which makes the browser
// re-filter a viewport-sized surface every time the pond canvas changes: free on a laptop,
// the dominant cost at 4K. Grading each colour once (and caching it) renders the same pixels.
const BRIGHTNESS = 1.08;
const SATURATE = 1.18;

const cache = new Map<string, string>();
const hex2 = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");

/** `#rgb`, `#rrggbb` or `#rrggbbaa` through brightness then saturate; anything else unchanged. */
export function tone(color: string): string {
  const hit = cache.get(color);
  if (hit !== undefined) return hit;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color);
  let out = color;
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    const r = parseInt(h.slice(0, 2), 16) * BRIGHTNESS;
    const g = parseInt(h.slice(2, 4), 16) * BRIGHTNESS;
    const b = parseInt(h.slice(4, 6), 16) * BRIGHTNESS;
    const s = SATURATE; // the CSS saturate() matrix
    out = `#${hex2((0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b)}${hex2((0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b)}${hex2((0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b)}${h.slice(6)}`;
  }
  cache.set(color, out);
  return out;
}
