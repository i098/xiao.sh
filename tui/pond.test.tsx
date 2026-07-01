import { expect, test } from "bun:test";
import { ManualClock } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { KoiPond } from "./app";

// smoke: the pond paints straight into the renderer's raw cell buffers, so a broken
// draw path renders nothing (or garbage) rather than throwing — assert on the frame.
test("koi pond renders fish and splashes stir the water", async () => {
  const mouseRef = { current: null as { x: number; y: number } | null };
  const splashRef = { current: [] as { x: number; y: number; amp: number }[] };
  const clock = new ManualClock();
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <KoiPond width={80} height={24} mouseRef={mouseRef} splashRef={splashRef} />,
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
