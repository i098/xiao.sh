// Projects shown on the Projects screen, fed to the AI context and the SEO surface. Every
// label is derived (src/lib/project-labels.ts); the only hand input is
// src/data/project-overrides.ts.
//  - `projects`: the committed snapshot (`bun run sync:projects`), synchronous, first paint.
//  - `getProjects()`: the daily cron's copy in the store (KV on the Worker) when present,
//    else the snapshot. The cron picks up new repos and their GitHub-derived labels; awards
//    are matched against the bundled LinkedIn snapshot, so they update on snapshot sync + redeploy.
//    The browser gets the same list through /api/projects
//    (web/dom/libs/projects.ts), because this file is compiled into the static /app.js.
import snapshot from "@/data/projects.json";
import { PROJECT_OVERRIDES, PROJECT_SOURCES } from "@/data/project-overrides";
import { applyOverrides, collectRepos, deriveProjects, parseHonours, type DeriveResult, type Project } from "@/lib/project-labels";
import { getLinkedInSnapshot } from "@/lib/linkedin";
import { profile } from "@/lib/profile";
import { get, put } from "@/lib/store";

export type { Project };

export const PROJECTS_KEY = "projects.json";

export const projects: Project[] = applyOverrides(snapshot as Project[], PROJECT_OVERRIDES);

export async function getProjects(): Promise<Project[]> {
  const raw = await get(PROJECTS_KEY).catch(() => null);
  if (raw) {
    try {
      const list: unknown = JSON.parse(raw);
      if (Array.isArray(list) && list.length > 0) return applyOverrides(list as Project[], PROJECT_OVERRIDES);
    } catch {
      // a corrupt store copy falls back to the snapshot
    }
  }
  return projects;
}

/** Collect from GitHub and derive every label; `token` is a GitHub token (GITHUB_TOKEN). */
export async function buildProjects(token: string): Promise<DeriveResult> {
  const login = profile.links.github.match(/github\.com\/([^/?#]+)/i)?.[1] ?? "";
  const li = await getLinkedInSnapshot();
  return deriveProjects({
    raws: await collectRepos(token, login, PROJECT_SOURCES.hackathonOrgs, PROJECT_SOURCES.repos),
    login,
    hackathonOrgs: PROJECT_SOURCES.hackathonOrgs,
    honours: parseHonours(li.sections?.find((s) => s.title === "Honors & Awards")?.items ?? []),
    narrative: [...(li.profile.narrative ?? []), ...(li.profile.achievements ?? [])],
    overrides: PROJECT_OVERRIDES,
    now: Date.now(),
  });
}

/** The daily cron: re-derive and store, so getProjects() serves fresh labels. */
export async function refreshProjects(token: string): Promise<number> {
  const { projects: list } = await buildProjects(token);
  if (list.length === 0) throw new Error("refusing to store an empty project list");
  await put(PROJECTS_KEY, JSON.stringify(list));
  return list.length;
}
