import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import snapshot from "../src/data/projects.json";

// The Worker keeps .data in KV, so state must outlive the process: run the real Worker in
// workerd (`wrangler dev`, local KV persisted to a temp dir), stop it, start a fresh one on
// the same state, and check what carried over.
const persist = mkdtempSync(path.join(tmpdir(), "xiao-kv-"));
afterAll(() => rmSync(persist, { recursive: true, force: true }));
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };

// boot the Worker, poll `probe` until it answers (non-null), then stop the Worker
async function withWorker<T>(port: number, probe: (origin: string) => Promise<T | null>): Promise<T> {
  const dev = Bun.spawn(
    ["node_modules/.bin/wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", persist, "--show-interactive-dev-session=false"],
    { stdout: "ignore", stderr: "ignore", env },
  );
  try {
    const origin = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i += 1) {
      const got = await probe(origin).catch(() => null);
      if (got !== null) return got;
      // real delay: polling an external wrangler/workerd process that exposes no ready signal
      await Bun.sleep(500);
    }
    throw new Error("wrangler dev never answered");
  } finally {
    dev.kill();
    await dev.exited;
  }
}

const visitCount = (origin: string) =>
  fetch(`${origin}/api/boot`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" }).then(async (r) =>
    r.ok ? ((await r.json()) as { visit: { count: number } }).visit.count : null,
  );

test(".data (visit counter) survives a Worker restart through KV", async () => {
  const port = 18_000 + Math.floor(Math.random() * 2000);
  const first = await withWorker(port, visitCount);
  const second = await withWorker(port, visitCount);
  expect(first).toBe(1);
  expect(second).toBe(2);
}, 120_000);

// The daily cron writes re-derived labels to KV key projects.json. Whatever it wrote last is
// what a fresh load shows - /api/projects (which the browser twin reads), the SEO block and
// llms.txt - with the same bundle, no rebuild or redeploy.
test("project labels in KV win over the bundled snapshot", async () => {
  const fresh = [{ ...snapshot[0], repo: "undeemed/kv-sentinel", title: "KV Sentinel", summary: "Written by the daily refresh." }];
  const put = Bun.spawnSync(
    ["node_modules/.bin/wrangler", "kv", "key", "put", "projects.json", JSON.stringify(fresh), "--binding", "DATA", "--local", "--persist-to", persist],
    { env },
  );
  expect(put.exitCode).toBe(0);
  const port = 18_000 + Math.floor(Math.random() * 2000);
  const seen = await withWorker(port, async (origin) => {
    const api = await fetch(`${origin}/api/projects`);
    if (!api.ok) return null;
    const list = (await api.json()) as { title: string }[];
    const page = await (await fetch(`${origin}/`)).text();
    const llms = await (await fetch(`${origin}/llms.txt`)).text();
    return { titles: list.map((p) => p.title), page: page.includes("KV Sentinel"), llms: llms.includes("KV Sentinel") };
  });
  expect(seen).toEqual({ titles: ["KV Sentinel"], page: true, llms: true });
}, 120_000);
