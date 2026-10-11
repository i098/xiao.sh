import { expect, test } from "bun:test";
import { getProjects, projects, PROJECTS_KEY, type Project } from "./projects";
import { useStore } from "./store";

const kv = new Map<string, string>();
useStore({ get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) });

const entry = (repo: string) => ({ ...projects[0], repo }) as Project;

test("a store list that still has the retired account serves the bundle, with overrides applied", async () => {
  kv.set(PROJECTS_KEY, JSON.stringify([entry("undeemed/pinger"), entry("undeemed/other")]));
  const list = await getProjects();
  expect(list).toBe(projects);
  expect(list.some((p) => p.repo.startsWith("undeemed/") || p.repo === "i098/pinger")).toBe(false);
});

test("a fresh store list is served over the bundle", async () => {
  kv.set(PROJECTS_KEY, JSON.stringify([entry("i098/pinger"), entry("i098/fresh")]));
  const list = await getProjects();
  expect(list.map((p) => p.repo)).toEqual(["i098/fresh"]);
});
