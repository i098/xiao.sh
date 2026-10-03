import { expect, test } from "bun:test";
import { ManualClock } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { KoiPond, CopyClearance } from "./app";

const TEXTURE = /[x+;:]/;

// smoke: the pond paints straight into the renderer's raw cell buffers, so a broken
// draw path renders nothing (or garbage) rather than throwing — assert on the frame.
test("koi pond renders fish and splashes stir the water", async () => {
  const mouseRef = { current: null as { x: number; y: number } | null };
  const splashRef = { current: [] as { x: number; y: number; amp: number }[] };
  const cellsRef = { current: new Uint16Array(0) };
  const clock = new ManualClock();
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <KoiPond width={80} height={24} mouseRef={mouseRef} splashRef={splashRef} cellsRef={cellsRef} />,
    { width: 80, height: 24, clock },
  );
  let t = 0;
  const frame = async () => {
    t += 16;
    clock.setTime(t);
    await renderOnce();
  };

  // ~3s of frames: koi swim in from the edges, wakes ripple
  for (let i = 0; i < 180; i += 1) await frame();
  const calm = captureCharFrame();

  // spam splashes like a fast cursor, then let the wave sim churn
  for (let i = 0; i < 40; i += 1) splashRef.current.push({ x: 10 + i, y: 12, amp: 2.2 });
  for (let i = 0; i < 30; i += 1) await frame();
  const choppy = captureCharFrame();

  const koiChars = (calm.match(/[#*•]/g) ?? []).length;
  const waterCalm = (calm.match(/[≈~˙·]/g) ?? []).length;
  const waterChoppy = (choppy.match(/[≈~˙·]/g) ?? []).length;
  expect(koiChars).toBeGreaterThan(0);
  expect(waterChoppy).toBeGreaterThan(waterCalm);
  renderer.destroy();
});

// The water texture fills calm water, but the pond must never read as a typo inside copy: no
// texture, ripple or koi glyph between the words of a line or within 2 cells of it, and no
// texture in the header/footer rows.
test("pond stays out of copy; texture stays out of the header/footer rows", async () => {
  const mouseRef = { current: null as { x: number; y: number } | null };
  const splashRef = { current: [] as { x: number; y: number; amp: number }[] };
  const cellsRef = { current: new Uint16Array(0) };
  const clock = new ManualClock();
  // letters that look like texture glyphs (x + ; :) are still copy and must survive
  const copy = "fix:  x+y; a:b";
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <box style={{ width: 80, height: 24 }}>
      <KoiPond width={80} height={24} mouseRef={mouseRef} splashRef={splashRef} cellsRef={cellsRef} />
      <box style={{ position: "absolute", left: 30, top: 12, zIndex: 1 }}>
        <text bg="transparent">{copy}</text>
      </box>
      {/* an indented list row: the gutter between the screen edge and the text stays clear */}
      <box style={{ position: "absolute", left: 4, top: 14, zIndex: 1 }}>
        <text bg="transparent">{"interpreter"}</text>
      </box>
      <CopyClearance cellsRef={cellsRef} width={80} height={24} />
    </box>,
    { width: 80, height: 24, clock },
  );
  clock.setTime(16);
  await renderOnce();
  await renderOnce();
  const rows = captureCharFrame().split("\n");

  // the texture is there: most body rows carry its glyphs
  expect(rows.slice(3, 21).filter((r) => TEXTURE.test(r)).length).toBeGreaterThan(10);
  // ... but not in the 3 header and 3 footer rows
  for (const r of [...rows.slice(0, 3), ...rows.slice(21, 24)]) expect(r).not.toMatch(TEXTURE);
  // the copy is intact, and its gaps and 2-cell margins hold no pond glyph at all
  expect(rows[12].slice(28, 32 + copy.length)).toBe(`  ${copy}  `);
  // no texture glyph in the gutter left of indented copy, where it would read as a bullet
  expect(rows[14].slice(0, 17)).toBe("    interpreter  ");
  renderer.destroy();
});
