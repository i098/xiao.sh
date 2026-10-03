// Browser twin of @/lib/projects. The real module (and its committed snapshot) would be
// compiled into the static /app.js, so the daily cron's KV copy could never reach visitors.
// `projects` is still the bundled snapshot - synchronous, so the first paint never waits -
// and getProjects() swaps in the live list from /api/projects (KV first, snapshot fallback).
import snapshot from "../../../src/data/projects.json";
import { PROJECT_OVERRIDES } from "../../../src/data/project-overrides";
import { applyOverrides, type Project } from "../../../src/lib/project-labels";
export type { Project };

export const projects: Project[] = applyOverrides(snapshot as Project[], PROJECT_OVERRIDES);

let live: Promise<Project[]> | null = null;
export function getProjects(): Promise<Project[]> {
  live ??= fetch("/api/projects")
    .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
    .then((list) => (Array.isArray(list) && list.length > 0 ? (list as Project[]) : projects))
    .catch(() => projects);
  return live;
}
