import { profile } from "@/lib/profile";

// GitHub pulse for the home screen: followers, public repos, total stars, last push.
// Unauthenticated GitHub API is 60 req/hr/IP, so cache hard (10 min). Set GITHUB_TOKEN to
// raise the limit. Never throws into render — returns the last good cache or null.
export type GitHubPulse = {
  login: string;
  followers: number;
  repos: number;
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
    const [uRes, rRes] = await Promise.all([
      fetch(`https://api.github.com/users/${login}`, { headers }),
      fetch(`https://api.github.com/users/${login}/repos?per_page=100&sort=pushed`, { headers }),
    ]);
    if (!uRes.ok) return cache?.data ?? null;
    const u = (await uRes.json()) as { followers?: number; public_repos?: number };
    const repos = rRes.ok ? ((await rRes.json()) as RawRepo[]) : [];
    const stars = repos.reduce((s, r) => s + (r.stargazers_count ?? 0), 0);
    const newest = repos.find((r) => !r.fork) ?? repos[0];
    const data: GitHubPulse = {
      login,
      followers: u.followers ?? 0,
      repos: u.public_repos ?? 0,
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
