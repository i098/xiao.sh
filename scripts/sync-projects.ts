// bun run sync:projects — re-derive every project label from GitHub (+ LinkedIn honours)
// and write the committed snapshot src/data/projects.json. Prints the rule behind each
// label so a wrong one shows its cause; fix it with one line in src/data/project-overrides.ts.
// Needs a GitHub token: GITHUB_TOKEN=$(gh auth token) bun run sync:projects
import { buildProjects } from "../src/lib/projects";

const token = process.env.GITHUB_TOKEN?.trim();
if (!token) {
  console.error("GITHUB_TOKEN is required (e.g. GITHUB_TOKEN=$(gh auth token) bun run sync:projects)");
  process.exit(1);
}

const { projects, skipped, why } = await buildProjects(token);
await Bun.write("src/data/projects.json", `${JSON.stringify(projects, null, 1)}\n`);

for (const p of projects) {
  const award = p.award ? `  ★ ${p.award.place} · ${p.award.event}${p.award.sure ? "" : " (guess)"}` : "";
  console.log(`${String(p.score).padStart(3)}  ${p.repo}  [${p.category} · ${p.origin} · ${p.status} · ${p.role}]${award}`);
  for (const w of why[p.repo] ?? []) console.log(`       ${w}`);
}
console.log(`\nskipped ${skipped.length}:`);
for (const s of skipped) console.log(`  ${s.repo} — ${s.why}`);
console.log(`\nwrote src/data/projects.json (${projects.length} projects)`);
