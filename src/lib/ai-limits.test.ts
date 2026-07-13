import { afterAll, expect, test } from "bun:test";
import { ask } from "./ai";

// Exercise the global abuse limits (MAX_CONCURRENT_ASKS=8, MAX_ASKS_PER_WINDOW=30/min)
// with OpenRouter fully mocked — no network, no real key.
process.env.OPENROUTER_API_KEY = "test-key";
process.env.OPENROUTER_DYNAMIC_MODELS = "false";
process.env.OPENROUTER_MODELS = "test/model";

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const okResponse = () =>
  new Response(JSON.stringify({ model: "test/model", choices: [{ message: { content: "ok" } }] }), {
    status: 200,
  });

const HI = [{ role: "user" as const, content: "hi" }];

test("ask() enforces global concurrency cap and per-minute window", async () => {
  // Phase 1: fill all 8 in-flight slots with a fetch that resolves on demand.
  const pending: Array<() => void> = [];
  globalThis.fetch = (async () => {
    await new Promise<void>((resolve) => pending.push(resolve));
    return okResponse();
  }) as typeof fetch;

  const inflight = Array.from({ length: 8 }, () => ask(HI));
  await Bun.sleep(20); // let all 8 enter the in-flight section

  const ninth = await ask(HI);
  expect(ninth.error).toMatch(/busy/i); // 9th concurrent ask sheds immediately

  pending.forEach((resolve) => resolve());
  for (const result of await Promise.all(inflight)) expect(result.answer).toBe("ok");

  // Phase 2: same 60s window — sequential asks until the window cap trips.
  // Rejected asks are not counted, so total admitted must be exactly 30.
  globalThis.fetch = (async () => okResponse()) as typeof fetch;
  let admitted = 8;
  let busyError: string | undefined;
  for (let i = 0; i < 30; i += 1) {
    const result = await ask(HI);
    if (result.answer) {
      admitted += 1;
    } else {
      busyError = result.error;
      break;
    }
  }
  expect(admitted).toBe(30);
  expect(busyError).toMatch(/busy/i);
});
