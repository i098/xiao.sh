// Browser twin of @/lib/github: the fetch + 10min cache live server-side.
import type { GitHubPulse } from "../../../src/lib/github";
export type { GitHubPulse };

export async function getGitHub(): Promise<GitHubPulse | null> {
  try {
    const r = await fetch("/api/github");
    return r.ok ? ((await r.json()) as GitHubPulse | null) : null;
  } catch {
    return null;
  }
}
