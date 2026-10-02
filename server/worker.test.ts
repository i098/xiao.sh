import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The Worker keeps .data in KV, so state must outlive the process: run the real Worker in
// workerd (`wrangler dev`, local KV persisted to a temp dir), stop it, start a fresh one on
// the same state, and check the visit counter carried over.
const persist = mkdtempSync(path.join(tmpdir(), "xiao-kv-"));
afterAll(() => rmSync(persist, { recursive: true, force: true }));

async function bootOnce(port: number): Promise<number> {
  const dev = Bun.spawn(
    ["node_modules/.bin/wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", persist, "--show-interactive-dev-session=false"],
    { stdout: "ignore", stderr: "ignore", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  try {
    const origin = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i += 1) {
      const r = await fetch(`${origin}/api/boot`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: "{}",
      }).catch(() => null);
      if (r?.ok) {
        const body: { visit: { count: number } } = await r.json();
        return body.visit.count;
      }
      // real delay: polling an external wrangler/workerd process that exposes no ready signal
      await Bun.sleep(500);
    }
    throw new Error("wrangler dev never answered /api/boot");
  } finally {
    dev.kill();
    await dev.exited;
  }
}

test(".data (visit counter) survives a Worker restart through KV", async () => {
  const port = 18_000 + Math.floor(Math.random() * 2000);
  const first = await bootOnce(port);
  const second = await bootOnce(port);
  expect(first).toBe(1);
  expect(second).toBe(2);
}, 120_000);
