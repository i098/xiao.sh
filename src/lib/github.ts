import { profile } from "@/lib/profile";

// GitHub pulse for the home screen: total commits, contributions (last year), total stars,
// last push. Unauthenticated GitHub API is rate-limited (search: 10 req/min), so cache hard
// (10 min). Set GITHUB_TOKEN to raise the limit. Never throws into render — returns the last
// good cache or null.
export type GitHubPulse = {
  login: string;
  commits: number; // all-time public commits (commit search total_count)
  contributions: number; // contributions in the last year (profile graph total)
  stars: number;
  lastPushName: string | null;
  lastPushAt: string | null;
};

const TTL = 10 * 60 * 1000;
let cache: { data: GitHubPulse; exp: number } | null = null;

function loginFromUrl(url: string): string {
  const m = url.match(/github\.com\/([^/?#]+)/i);
  return m ? m[1] : "";
}

type RawRepo = { stargazers_count?: number; name?: string; pushed_at?: string; fork?: boolean };

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

  try {
    const [cRes, gRes, rRes] = await Promise.all([
      // total_count = all indexed public commits authored by the login
      fetch(`https://api.github.com/search/commits?q=author:${login}&per_page=1`, { headers }),
      // the public profile graph page carries "N contributions in the last year" (no auth;
      // the GraphQL contributions API requires a token)
      fetch(`https://github.com/users/${login}/contributions`, { headers: { "User-Agent": "xiao.sh-tui" } }),
      fetch(`https://api.github.com/users/${login}/repos?per_page=100&sort=pushed`, { headers }),
    ]);
    if (!cRes.ok && !gRes.ok) return cache?.data ?? null;
    const commits = cRes.ok ? ((await cRes.json()) as { total_count?: number }).total_count ?? 0 : 0;
    let contributions = 0;
    if (gRes.ok) {
      const html = await gRes.text();
      const m = html.match(/js-contribution-activity-description[^>]*>\s*([\d,]+)/);
      if (m) contributions = Number(m[1].replace(/,/g, ""));
    }
    const repos = rRes.ok ? ((await rRes.json()) as RawRepo[]) : [];
    const stars = repos.reduce((s, r) => s + (r.stargazers_count ?? 0), 0);
    const newest = repos.find((r) => !r.fork) ?? repos[0];
    const data: GitHubPulse = {
      login,
      commits,
      contributions,
      stars,
      lastPushName: newest?.name ?? null,
      lastPushAt: newest?.pushed_at ?? null,
    };
    cache = { data, exp: Date.now() + TTL };
    return data;
  } catch {
    return cache?.data ?? null;
  }
}
