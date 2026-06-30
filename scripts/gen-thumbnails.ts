// Offline: decode each project image -> downscaled RGB -> half-block cell data.
// Output src/data/thumbnails.json keyed by project title. Run: bun run gen:thumbnails
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { projects } from "../src/lib/projects";

const COLS = 40; // thumbnail width in terminal columns
const ROWS_MAX = 11; // cap height so it fits the detail pane (each row = 2 px tall)

function hex(n: number) {
  return n.toString(16).padStart(2, "0");
}

const out: Record<string, [string, string][][]> = {};

for (const p of projects) {
  const candidates = [p.image, p.fallbackImage].filter(Boolean) as string[];
  for (const rel of candidates) {
    const file = path.join("public", rel);
    try {
      const { data, info } = await sharp(file)
        .resize({ width: COLS, height: ROWS_MAX * 2, fit: "inside" })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const w = info.width;
      let h = info.height;
      if (h % 2 === 1) h -= 1; // even rows so they pair into half-blocks (▀ = top fg / bottom bg)

      const rows: [string, string][][] = [];
      for (let y = 0; y < h; y += 2) {
        const row: [string, string][] = [];
        for (let x = 0; x < w; x++) {
          const t = (y * w + x) * 3;
          const b = ((y + 1) * w + x) * 3;
          row.push([
            hex(data[t]) + hex(data[t + 1]) + hex(data[t + 2]),
            hex(data[b]) + hex(data[b + 1]) + hex(data[b + 2]),
          ]);
        }
        rows.push(row);
      }
      out[p.title] = rows;
      break;
    } catch {
      // try fallback image
    }
  }
}

writeFileSync(path.join("src", "data", "thumbnails.json"), JSON.stringify(out));
console.log(`wrote ${Object.keys(out).length}/${projects.length} thumbnails -> src/data/thumbnails.json`);
