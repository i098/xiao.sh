import { profile } from "@/lib/profile";
import { get, put } from "@/lib/store";

// GitHub pulse for the home screen: total commits, contributions (last year), total stars,
// last push. Unauthenticated GitHub API is rate-limited (search: 10 req/min), so cache hard
// (10 min). Set GITHUB_TOKEN to raise the limit. Never throws into render.
// Each field comes from its own call and is independent: a failed call or a missed parse
// never yields 0 — the field keeps its last good value (persisted in the store, so it
// survives isolate recycling) or is absent.
export type GitHubPulse = {
  login: string;
  commits?: number; // all-time public commits (commit search total_count)
  contributions?: number; // contributions in the last year (profile graph total)
  stars?: number;
  lastPushName?: string | null;
  lastPushAt?: string | null;
};

const TTL = 10 * 60 * 1000;
const KEY = "github.json";
let cache: { data: GitHubPulse | null; exp: number } | null = null;

function loginFromUrl(url: string): string {
  const m = url.match(/github\.com\/([^/?#]+)/i);
  return m ? m[1] : "";
}

type RawRepo = { stargazers_count?: number; name?: string; pushed_at?: string; fork?: boolean };

async function call<T>(req: Promise<Response>, read: (r: Response) => Promise<T | undefined>): Promise<T | undefined> {
  try {
    const r = await req;
    return r.ok ? await read(r) : undefined;
  } catch {
    return undefined;
  }
}

export async function getGitHub(): Promise<GitHubPulse | null> {
  if (cache && cache.exp > Date.now()) return cache.data;
  const login = loginFromUrl(profile.links.github);
  if (!login) return null;

  const headers: Record<string, string> = {
    "User-Agent": "xiao.sh-tui",
    Accept: "application/vnd.github+json",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  const [commits, contributions, repos, stored] = await Promise.all([
    // total_count = all indexed public commits authored by the login; is:public keeps a
    // GITHUB_TOKEN from adding commits in private repos the token can see
    call(fetch(`https://api.github.com/search/commits?q=author:${login}+is:public&per_page=1`, { headers }), async (r) => {
      const n = ((await r.json()) as { total_count?: number }).total_count;
      return typeof n === "number" ? n : undefined;
    }),
    // the public profile graph page carries "N contributions in the last year" (no auth;
    // the GraphQL contributions API requires a token)
    call(fetch(`https://github.com/users/${login}/contributions`, { headers: { "User-Agent": "xiao.sh-tui" } }), async (r) => {
      const m = (await r.text()).match(/js-contribution-activity-description[^>]*>\s*([\d,]+)/);
      return m ? Number(m[1].replace(/,/g, "")) : undefined;
    }),
    // stars and last push come only from the repos call
    call(fetch(`https://api.github.com/users/${login}/repos?per_page=100&sort=pushed`, { headers }), async (r) => {
      const a = await r.json();
      return Array.isArray(a) ? (a as RawRepo[]) : undefined;
    }),
    get(KEY)
      .then((s): GitHubPulse | null => {
        const p = JSON.parse(s ?? "null");
        if (!p || typeof p !== "object") return null;
        const num = (v: unknown) => (typeof v === "number" ? v : undefined);
        const str = (v: unknown) => (typeof v === "string" ? v : null);
        return {
          login,
          commits: num(p.commits),
          contributions: num(p.contributions),
          stars: num(p.stars),
          lastPushName: str(p.lastPushName),
          lastPushAt: str(p.lastPushAt),
        };
      })
      .catch(() => null),
  ]);

  const data: GitHubPulse = { ...stored, login };
  if (commits !== undefined) data.commits = commits;
  if (contributions !== undefined) data.contributions = contributions;
  if (repos) {
    const newest = repos.find((r) => !r.fork) ?? repos[0];
    data.stars = repos.reduce((s, r) => s + (r.stargazers_count ?? 0), 0);
    data.lastPushName = newest?.name ?? null;
    data.lastPushAt = newest?.pushed_at ?? null;
  }
  const any = data.commits !== undefined || data.contributions !== undefined || data.stars !== undefined;
  const result = any ? data : null;
  if (any && (commits !== undefined || contributions !== undefined || repos)) await put(KEY, JSON.stringify(data)).catch(() => {});
  cache = { data: result, exp: Date.now() + TTL };
  return result;
}
