import { afterAll, expect, setSystemTime, test } from "bun:test";
import { getGitHub } from "./github";
import type * as GitHubModule from "./github";
import { useStore } from "./store";

// GitHub fully mocked: a failed call or missed parse must never read as 0 for its field.
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});

const kv = new Map<string, string>();
useStore({ get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) });

let commitsOk = true;
let pageHtml = '<h2 class="js-contribution-activity-description">9,459 contributions';
let reposOk = true;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  const limited = () => Response.json({ message: "API rate limit exceeded" }, { status: 403 });
  if (url.includes("/search/commits")) return commitsOk ? Response.json({ total_count: 2621 }) : limited();
  if (url.includes("/contributions")) return new Response(pageHtml);
  if (!reposOk) return limited();
  return Response.json([
    { name: "a", stargazers_count: 24, fork: false, pushed_at: "2026-10-03T00:00:00Z" },
    { name: "b", stargazers_count: 45, fork: true, pushed_at: "2026-10-02T00:00:00Z" },
  ]);
}) as unknown as typeof fetch;

let now = Date.now();
const refetch = () => {
  now += 11 * 60 * 1000; // past the 10 min cache
  setSystemTime(now);
  return getGitHub();
};

// query suffix = new module instance; a non-literal specifier keeps tsc from resolving it
const freshModule = (tag: string): Promise<typeof GitHubModule> => {
  const specifier = `./github?${tag}`;
  return import(specifier);
};

test("failed fields are omitted, then keep their last good value, never 0", async () => {
  reposOk = false;
  const first = await refetch(); // rate-limited repos, nothing stored yet
  expect(first).toMatchObject({ commits: 2621, contributions: 9459 });
  expect(first?.stars).toBeUndefined();

  reposOk = true;
  expect((await refetch())?.stars).toBe(69);

  reposOk = false;
  commitsOk = false;
  pageHtml = "<html>no match</html>";
  const degraded = await refetch(); // every call fails: last good values survive
  expect(degraded).toMatchObject({ commits: 2621, contributions: 9459, stars: 69, lastPushName: "a" });
});

test("last good pulse survives an isolate recycle via the store", async () => {
  // a fresh isolate has no in-memory cache: re-import the module with every call failing
  commitsOk = false;
  reposOk = false;
  pageHtml = "";
  const fresh = await freshModule("recycled");
  expect(fresh.getGitHub).not.toBe(getGitHub);
  expect(await fresh.getGitHub()).toMatchObject({ commits: 2621, contributions: 9459, stars: 69 });

  kv.clear(); // control: with the store empty the same fresh instance has nothing to fall back on
  const empty = await freshModule("recycled-empty");
  expect(await empty.getGitHub()).toBeNull();

  kv.set("github.json", "{not json"); // corrupt store must not throw into render
  const corrupt = await freshModule("recycled-corrupt");
  expect(await corrupt.getGitHub()).toBeNull();
});

test("a stale isolate does not erase fields another isolate stored", async () => {
  kv.clear();
  commitsOk = false;
  reposOk = false;
  pageHtml = "";
  const a = await freshModule("iso-a");
  expect(await a.getGitHub()).toBeNull(); // A caches null

  kv.set("github.json", JSON.stringify({ login: "x", commits: 2621, contributions: 9459, stars: 69 })); // B writes
  commitsOk = true;
  const refreshed = await (async () => {
    now += 11 * 60 * 1000;
    setSystemTime(now);
    return a.getGitHub();
  })(); // only commits succeeds
  expect(refreshed).toMatchObject({ commits: 2621, contributions: 9459, stars: 69 });
  expect(JSON.parse(kv.get("github.json")!)).toMatchObject({ contributions: 9459, stars: 69 });
});
