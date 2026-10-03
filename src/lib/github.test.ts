import { afterAll, expect, test } from "bun:test";
import { getGitHub } from "./github";

// GitHub fully mocked: a rate-limited repos call (403) must never read as 0 stars.
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

let reposStatus = 403;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/search/commits")) return Response.json({ total_count: 2621 });
  if (url.includes("/contributions")) return new Response('<h2 class="js-contribution-activity-description">9,459 contributions');
  if (reposStatus !== 200) return Response.json({ message: "API rate limit exceeded" }, { status: reposStatus });
  return Response.json([
    { name: "a", stargazers_count: 24, fork: false, pushed_at: "2026-10-03T00:00:00Z" },
    { name: "b", stargazers_count: 45, fork: true, pushed_at: "2026-10-02T00:00:00Z" },
  ]);
}) as unknown as typeof fetch;

test("a rate-limited repos call is not reported or cached as 0 stars", async () => {
  expect(await getGitHub()).toBeNull(); // no good data yet: omit the line, don't claim 0★
  reposStatus = 200;
  const pulse = await getGitHub(); // the failure was not cached, so the next call recovers
  expect(pulse?.stars).toBe(69);
  expect(pulse?.lastPushName).toBe("a");
});
