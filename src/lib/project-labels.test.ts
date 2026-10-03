import { expect, test } from "bun:test";
import { applyOverrides, deriveProjects, parseHonours, type RawRepo } from "./project-labels";

const NOW = Date.parse("2026-10-03T00:00:00Z");
const repo = (over: Partial<RawRepo> & { repo: string }): RawRepo => ({
  name: over.repo.split("/")[1],
  owner: over.repo.split("/")[0],
  description: "A thing that does things for people who need things done.",
  topics: [],
  languages: { TypeScript: 900, CSS: 100 },
  readme: "",
  stars: 0,
  fork: false,
  archived: false,
  created: "2026-02-20T00:00:00Z",
  pushedAt: "2026-02-22T00:00:00Z",
  homepage: "",
  commits: 10,
  mine: 10,
  ...over,
});
const honours = parseHonours([
  "RETURN OF THE AGENTS Hackathon - 1st Overall Afore Capital Feb 2026",
  "1st Place Logistic's Track - Santa's Ho's HackNight by Dedalus Labs Dedalus Labs Dec 2025",
  "DECA Business Operations Research State Qualifier DECA Jan 2025",
]);
const derive = (raws: RawRepo[], overrides = {}, narrative: string[] = []) =>
  deriveProjects({ raws, login: "me", hackathonOrgs: ["team"], honours, narrative, overrides, now: NOW });

test("honours: hackathons only, newest first, place and event read from LinkedIn's wording", () => {
  expect(honours.map((h) => [h.place, h.event, h.at])).toEqual([
    ["1st overall", "RETURN OF THE AGENTS Hackathon", "2026-02-01"],
    ["1st · Logistic track", "Santa's Ho's HackNight", "2025-12-01"],
  ]);
});

test("filter: forks without real work, repos without his commits and meta repos are skipped", () => {
  const { projects, skipped } = derive([
    repo({ repo: "me/keep" }),
    repo({ repo: "me/forked", fork: true, mine: 29, commits: 900 }),
    repo({ repo: "me/forkwork", fork: true, mine: 30, commits: 900 }),
    repo({ repo: "me/theirs", mine: 0 }),
    repo({ repo: "me/me" }),
  ]);
  expect(projects.map((p) => p.repo).sort()).toEqual(["me/forkwork", "me/keep"]);
  expect(Object.fromEntries(skipped.map((s) => [s.repo, s.why]))).toEqual({
    "me/forked": "fork without real work",
    "me/theirs": "no commits by me",
    "me/me": "meta repo",
  });
});

test("awards: a LinkedIn post naming the repo wins, and each honour goes to one repo only", () => {
  const { projects } = derive(
    [repo({ repo: "team/interpreter" }), repo({ repo: "team/other", readme: "built at the RETURN OF THE AGENTS hackathon" })],
    {},
    ["We built Interpreter, placing 1st at the RETURN OF THE AGENTS hackathon!"],
  );
  const by = Object.fromEntries(projects.map((p) => [p.repo, p.award]));
  expect(by["team/interpreter"]).toMatchObject({ place: "1st overall", sure: true });
  expect(by["team/other"]).toBeUndefined();
});

test("role counts GitHub accounts when fetched; bot commits do not make a solo repo a team one", () => {
  const { projects } = derive([
    repo({ repo: "me/solo", commits: 40, mine: 4, contributors: [{ login: "me", n: 4 }] }),
    repo({ repo: "team/led", commits: 100, mine: 48, contributors: [{ login: "me", n: 48 }, { login: "a", n: 40 }, { login: "b", n: 12 }] }),
    repo({ repo: "team/joined", commits: 100, mine: 20, contributors: [{ login: "a", n: 70 }, { login: "me", n: 20 }] }),
  ]);
  expect(Object.fromEntries(projects.map((p) => [p.repo, p.role]))).toEqual({ "me/solo": "solo", "team/led": "lead", "team/joined": "team" });
});

test("role falls back on the GraphQL share when the contributors fetch failed", () => {
  const { projects } = derive([
    repo({ repo: "team/minor", commits: 70, mine: 7 }),
    repo({ repo: "team/half", commits: 70, mine: 40 }),
  ]);
  expect(Object.fromEntries(projects.map((p) => [p.repo, p.role]))).toEqual({ "team/minor": "team", "team/half": "lead" });
});

test("overrides beat derived labels at sync time and again at read time", () => {
  const overrides = { "me/a": { set: { title: "Better A" } }, "me/b": { hide: true } };
  const { projects } = derive([repo({ repo: "me/a" }), repo({ repo: "me/b" })], overrides);
  expect(projects.map((p) => [p.repo, p.title])).toEqual([["me/a", "Better A"]]);
  // a stored copy from before the override was added still comes out overridden
  const stale = derive([repo({ repo: "me/a" }), repo({ repo: "me/b" })]).projects;
  expect(applyOverrides(stale, overrides).map((p) => [p.repo, p.title])).toEqual([["me/a", "Better A"]]);
});
