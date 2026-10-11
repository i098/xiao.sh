// Auto-labelling for the Projects screen: collect public repo data from GitHub, then derive
// every label (title, summary, category, origin, stack, award, status, role, rank) with
// deterministic rules, so nothing is hand-typed beyond src/data/project-overrides.ts.
// Shared by `bun run sync:projects` (writes the committed snapshot) and the Worker's daily
// cron (writes KV). Pure fetch + string work: runs on Bun, workerd and in the browser.

export type Award = { place: string; event: string; when: string; at: string; sure: boolean };
export type Project = {
  repo: string; // owner/name
  title: string;
  summary: string;
  category: string;
  origin: "hackathon" | "personal" | "research" | "contrib";
  stack: string[]; // code languages (>= 8%, max 3) + detected frameworks (max 3)
  langs: { name: string; pct: number }[];
  year: number;
  created: string;
  pushedAt: string;
  status: "active" | "recent" | "shipped" | "dormant" | "archived";
  role: "solo" | "lead" | "team" | "contributor";
  share: number; // his share of default-branch commits, 0..1
  commits: number; // his default-branch commits
  stars: number;
  award?: Award;
  homepage?: string;
  githubUrl?: string;
  linkedinUrl?: string;
  eventUrl?: string;
  score: number;
};
export type ProjectOverride = { hide?: boolean; show?: boolean; set?: Partial<Project> };
export type Honour = { place: string; event: string; when: string; at: string; text: string };

export type RawRepo = {
  repo: string;
  name: string;
  owner: string;
  description: string;
  topics: string[];
  languages: Record<string, number>; // bytes
  readme: string;
  stars: number;
  fork: boolean;
  archived: boolean;
  created: string;
  pushedAt: string;
  homepage: string;
  commits: number; // all default-branch commits
  mine: number; // his
  // REST /contributors (GitHub accounts only, so bot/unlinked authors drop out), fetched only
  // where GraphQL's share is ambiguous (< 90%) to stay inside the Worker's subrequest budget
  contributors?: { login: string; n: number }[];
};

const DAY = 86_400_000;

// ---- collect ------------------------------------------------------------------------------
// GitHub GraphQL: ~1 request per 25 repos instead of 3 REST calls per repo, which keeps the
// Worker cron far below its subrequest cap. Needs a token (any scope reads public repos).
const REPO_FIELDS = `
  nameWithOwner name description isFork isArchived stargazerCount createdAt pushedAt homepageUrl
  owner { login }
  repositoryTopics(first: 20) { nodes { topic { name } } }
  languages(first: 12, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name } } }
  r1: object(expression: "HEAD:README.md") { ... on Blob { text } }
  r2: object(expression: "HEAD:readme.md") { ... on Blob { text } }
  r3: object(expression: "HEAD:Readme.md") { ... on Blob { text } }
  defaultBranchRef { target { ... on Commit {
    all: history(first: 0) { totalCount }
    mine: history(first: 0, author: { emails: $emails }) { totalCount }
  } } }`;

type GqlRepo = {
  nameWithOwner: string; name: string; description: string | null; isFork: boolean; isArchived: boolean;
  stargazerCount: number; createdAt: string; pushedAt: string; homepageUrl: string | null;
  owner: { login: string };
  repositoryTopics: { nodes: { topic: { name: string } }[] };
  languages: { edges: { size: number; node: { name: string } }[] };
  r1: { text?: string } | null; r2: { text?: string } | null; r3: { text?: string } | null;
  defaultBranchRef: { target: { all?: { totalCount: number }; mine?: { totalCount: number } } } | null;
};
type Page = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlRepo[] };

async function gql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "xiao.sh-projects", "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await r.json()) as { data?: T; errors?: { message: string }[] };
  if (!r.ok || !body.data) throw new Error(`github graphql ${r.status}: ${body.errors?.[0]?.message ?? "no data"}`);
  return body.data;
}

function toRaw(g: GqlRepo): RawRepo {
  const t = g.defaultBranchRef?.target;
  return {
    repo: g.nameWithOwner,
    name: g.name,
    owner: g.owner.login,
    description: (g.description ?? "").trim(),
    topics: g.repositoryTopics.nodes.map((n) => n.topic.name),
    languages: Object.fromEntries(g.languages.edges.map((e) => [e.node.name, e.size])),
    readme: (g.r1?.text ?? g.r2?.text ?? g.r3?.text ?? "").slice(0, 6000),
    stars: g.stargazerCount,
    fork: g.isFork,
    archived: g.isArchived,
    created: g.createdAt,
    pushedAt: g.pushedAt,
    homepage: g.homepageUrl ?? "",
    commits: t?.all?.totalCount ?? 0,
    mine: t?.mine?.totalCount ?? 0,
  };
}

/**
 * Every public repo owned by `login` or `orgs`, plus `repos` ("owner/name"). "His" commits are
 * matched by author email, not account id: `extraEmails` carries the old account's addresses,
 * so history written before the account moved still counts.
 */
export async function collectRepos(token: string, login: string, orgs: string[], repos: string[], extraEmails: string[] = []): Promise<RawRepo[]> {
  const { user } = await gql<{ user: { databaseId: number } }>(token, "query($l:String!){ user(login:$l){ databaseId } }", { l: login });
  const emails = [...extraEmails, `${user.databaseId}+${login}@users.noreply.github.com`];
  const out: RawRepo[] = [];
  const owners: [string, string][] = [["user", login], ...orgs.map((o): [string, string] => ["organization", o])];
  for (const [kind, name] of owners) {
    const affil = kind === "user" ? ", ownerAffiliations: OWNER" : "";
    let after: string | null = null;
    do {
      const data: Record<string, { repositories: Page }> = await gql(
        token,
        `query($n:String!,$after:String,$emails:[String!]!){ ${kind}(login:$n){ repositories(first:25, after:$after, privacy:PUBLIC${affil}){
          pageInfo { hasNextPage endCursor } nodes { ${REPO_FIELDS} } } } }`,
        { n: name, after, emails },
      );
      const page = data[kind].repositories;
      out.push(...page.nodes.map(toRaw));
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
  }
  for (const full of repos) {
    const [owner, name] = full.split("/");
    const data = await gql<{ repository: GqlRepo | null }>(
      token,
      `query($o:String!,$n:String!,$emails:[String!]!){ repository(owner:$o, name:$n){ ${REPO_FIELDS} } }`,
      { o: owner, n: name, emails },
    );
    if (data.repository) out.push(toRaw(data.repository));
  }
  const ambiguous = out.filter((r) => !r.fork && r.mine > 0 && r.mine / (r.commits || 1) < 0.9);
  await Promise.all(
    ambiguous.map(async (r) => {
      const res = await fetch(`https://api.github.com/repos/${r.repo}/contributors?per_page=30`, {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": "xiao.sh-projects", Accept: "application/vnd.github+json" },
      });
      if (!res.ok) return;
      const list = (await res.json()) as { login?: string; contributions?: number }[];
      r.contributors = list.map((c) => ({ login: c.login ?? "", n: c.contributions ?? 0 }));
    }),
  );
  return out;
}

// ---- honours (LinkedIn "Honors & Awards") ---------------------------------------------------
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Hackathon honours only (school awards stay on LinkedIn), newest first. */
export function parseHonours(items: string[]): Honour[] {
  return items
    .filter((t) => /hack/i.test(t))
    .map((text) => {
      const d = text.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})$/);
      const place = (text.match(/\b(1st|2nd|3rd|Top \d+|Track Prize)\b/) ?? ["Winner"])[0];
      // "Event - Track Place Org Mon YYYY" or "Place Track - Event by Org ..." or "Event Place Org ..."
      const [left, right] = text.split(" - ");
      const event = (right && /\b(1st|2nd|3rd|Top \d+)\b/.test(left) ? right : left)
        .replace(/\b(1st|2nd|3rd|Top \d+)\b.*$/, "")
        .replace(/ by .*$/, "")
        .replace(/\s+/g, " ")
        .trim();
      const track = text.match(/(\w+(?:'s)?) Track/)?.[1]?.replace(/'s$/, "");
      const label = place === "1st" && /Overall/.test(text) ? "1st overall" : track && place !== "Track Prize" ? `${place} · ${track} track` : place;
      const at = d ? `${d[2]}-${String(MONTHS.indexOf(d[1]) + 1).padStart(2, "0")}-01` : "";
      return { place: label, event, when: d ? `${d[1]} ${d[2]}` : "", at, text };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

// ---- derive -------------------------------------------------------------------------------
// category: the rule with the most keyword hits in name + description + topics wins; ties go
// to the earlier rule; no hit -> "Web apps"
const CATEGORIES: [string, RegExp][] = [
  ["ML systems", /\b(inference|diffusion|mlx|moe|quantiz\w*|transformers?|spectrogram|neural|safetensors|llm-inference|machine-learning)\b/gi],
  ["Agents & AI", /\b(agents?|agentic|llm|gpt|gemini|claude|mistral|openrouter|ai|mcp|memory|translat\w*|speech|automat\w*)\b/gi],
  ["Dev tools", /\b(plugin|cli|skills?|extension|developer-tools|codex|vscode|harness|benchmarks?|claude-code-plugin|code-quality)\b/gi],
  ["Research", /\b(research|neutron|reflectivity|simulation)\b/gi],
  ["Infra", /\b(kubernetes|vps|ansible|docker|cluster|tailscale|iac|fleet|vps-deployment)\b/gi],
  ["Hardware & games", /\b(robots?|humanoid|vr|fps|frame-time|overclocking|gaming|hardware|game-mod|teleoperation)\b/gi],
  ["Finance", /\b(stocks?|sec|filings?|insider|crypto|fundrais\w*|finance)\b/gi],
];
function categorize(r: RawRepo): [string, string] {
  const hay = `${r.name.replace(/[-_]/g, " ")} ${r.description} ${r.topics.join(" ")}`;
  let best: [string, string] = ["Web apps", "no keyword hit"];
  let bestN = 0;
  for (const [name, re] of CATEGORIES) {
    const hits = hay.match(re) ?? [];
    if (hits.length > bestN) [best, bestN] = [[name, `${hits.length} hits: ${[...new Set(hits.map((h) => h.toLowerCase()))].slice(0, 3).join(", ")}`], hits.length];
  }
  return best;
}

// markup/config languages never count as "the stack"
const MARKUP = ["CSS", "SCSS", "HTML", "Dockerfile", "Makefile", "Procfile", "Batchfile", "Jupyter Notebook", "MDX", "Nix"];
const FRAMEWORKS: [string, RegExp][] = [
  ["Next.js", /next\.?js|"next":/i],
  ["React", /\breact\b/i],
  ["Svelte", /svelte/i],
  ["FastAPI", /fastapi/i],
  ["Supabase", /supabase/i],
  ["MongoDB", /mongo/i],
  ["PostgreSQL", /postgres/i],
  ["Redis", /\bredis\b/i],
  ["Stripe", /\bstripe\b/i],
  ["Cloudflare", /cloudflare|wrangler/i],
  ["Docker", /docker/i],
  ["PyTorch", /pytorch|\btorch\b/i],
  ["MLX", /\bmlx\b/i],
  ["Modal", /\bmodal\b/i],
  ["Bun", /\bbun\b/i],
];
function stackOf(r: RawRepo): Pick<Project, "stack" | "langs"> {
  const total = Object.values(r.languages).reduce((a, b) => a + b, 0) || 1;
  const langs = Object.entries(r.languages)
    .map(([name, bytes]) => ({ name, pct: Math.round((bytes / total) * 100) }))
    .filter((l) => l.pct >= 1)
    .sort((a, b) => b.pct - a.pct);
  const code = langs.filter((l) => !MARKUP.includes(l.name) && l.pct >= 8).map((l) => l.name);
  const hay = `${r.topics.join(" ")} ${r.description} ${r.readme.slice(0, 3000)}`;
  const fw = FRAMEWORKS.filter(([, re]) => re.test(hay)).map(([n]) => n);
  return { stack: [...new Set([...code.slice(0, 3), ...fw.slice(0, 3)])], langs };
}

// a description shaped "Long Name (ACRONYM)" expands an acronym repo name (ICBG)
function titleOf(r: RawRepo): string {
  const m = r.description.match(/^([A-Z][\w ]+?) \(([A-Z]+)\)$/);
  return m && m[2] === r.name ? m[1] : r.name;
}

// the description, else the README's first prose paragraph; first sentence of 40-150 chars
function summaryOf(r: RawRepo, title: string): string {
  let s = r.description;
  if (!s || s === title || s.length < 25 || /\(([A-Z]+)\)$/.test(s)) {
    const para = r.readme
      .split(/\n\s*\n/)
      .map((p) => p.replace(/<[^>]+>/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").trim())
      .find((p) => p.length > 40 && !/^[#|>\-]/.test(p));
    if (para) s = para;
  }
  s = s.replace(/:[a-z_]+:/g, "").replace(/\s+/g, " ").trim();
  const cut = s.match(/^(.{40,150}?[.!?])(\s|$)/);
  return cut ? cut[1] : s.length > 150 ? `${s.slice(0, 149)}…` : s;
}

// why a repo is left out, or null to keep it
function exclusion(r: RawRepo, login: string): string | null {
  if (r.name === ".github" || r.name === login) return "meta repo";
  if (!r.description && r.readme.length < 200) return "no description or README";
  if (r.fork && r.mine < 30) return "fork without real work";
  if (r.mine === 0) return `no commits by ${login}`;
  return null;
}

// Awards: each honour goes to at most one repo and each repo gets at most one honour.
//  sure:  a LinkedIn post names the repo -> the honour that best fits that post (shared
//         event words, same placement, dated within 45 days of the repo's creation)
//  guess: a hackathon repo whose own text shares rare honour words (IDF-weighted), within
//         45 days of creation
// Highest score claims first.
const GENERIC = ["hackathon", "track", "agents", "full", "stack", "beyond", "place", "overall", "prize", "issued"];
const words = (s: string) => new Set((s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !GENERIC.includes(w)));
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function assignAwards(repos: RawRepo[], honours: Honour[], narrative: string[], hackathonOrgs: string[]): Record<string, { h: Honour; sure: boolean; why: string }> {
  type Hit = { h: Honour; sure: boolean; why: string; score: number; repo: string };
  const hits: Hit[] = [];
  const docs = repos.map((r) => words(`${r.name} ${r.description} ${r.topics.join(" ")} ${r.readme}`));
  const idf = (w: string) => Math.log(repos.length / (1 + docs.filter((d) => d.has(w)).length));
  repos.forEach((r, i) => {
    const made = Date.parse(r.created);
    const near = (h: Honour) => Math.abs(Date.parse(h.at) - made) < 45 * DAY;
    const names = [r.name, titleOf(r)].map(compact).filter((n) => n.length >= 5);
    const post = narrative.find((s) => names.some((n) => compact(s).includes(n)));
    if (post) {
      const pw = words(post);
      const placed = post.match(/\b(1st|2nd|3rd|top \d+|finalist)\b/i)?.[0].toLowerCase();
      for (const h of honours) {
        const s =
          [...words(h.event)].filter((w) => pw.has(w)).length * 2 +
          (placed && (h.place.toLowerCase().startsWith(placed) || (placed === "finalist" && /top/i.test(h.place))) ? 2 : 0) +
          (near(h) ? 1 : 0);
        if (s >= 2) hits.push({ h, sure: true, why: `LinkedIn post names "${r.name}"`, score: 100 + s, repo: r.repo });
      }
      return;
    }
    if (!hackathonOrgs.includes(r.owner) && !/hackathon/i.test(r.readme)) return;
    for (const h of honours) {
      if (!near(h)) continue;
      const shared = [...words(h.text)].filter((w) => docs[i].has(w));
      const s = shared.reduce((a, w) => a + idf(w), 0);
      if (s >= 2) hits.push({ h, sure: false, why: `guess: shares "${shared.join(", ")}" with the honour, ${h.when}`, score: s, repo: r.repo });
    }
  });
  const out: Record<string, { h: Honour; sure: boolean; why: string }> = {};
  const taken: Honour[] = [];
  for (const a of hits.sort((x, y) => y.score - x.score)) {
    if (out[a.repo] || taken.includes(a.h)) continue;
    out[a.repo] = a;
    taken.push(a.h);
  }
  return out;
}

/** Overrides at read time: drop hidden repos, merge `set` fields (idempotent). */
export function applyOverrides(list: Project[], overrides: Record<string, ProjectOverride>): Project[] {
  return list.filter((p) => !overrides[p.repo]?.hide).map((p) => ({ ...p, ...overrides[p.repo]?.set }));
}

export type DeriveInput = {
  raws: RawRepo[];
  login: string;
  aliases?: string[]; // his earlier logins: contributor rows under them count as him
  hackathonOrgs: string[];
  honours: Honour[];
  narrative: string[]; // LinkedIn post text, used to match awards for sure
  overrides: Record<string, ProjectOverride>;
  now: number;
};
export type DeriveResult = {
  projects: Project[];
  skipped: { repo: string; why: string }[];
  why: Record<string, string[]>; // per repo: the rule behind each label, for the sync log
};

export function deriveProjects({ raws, login, aliases = [], hackathonOrgs, honours, narrative, overrides, now }: DeriveInput): DeriveResult {
  const me = new Set([login, ...aliases].map((l) => l.toLowerCase()));
  const kept = raws.filter((r) => (!exclusion(r, login) || overrides[r.repo]?.show) && !overrides[r.repo]?.hide);
  const skipped = raws.filter((r) => !kept.includes(r)).map((r) => ({ repo: r.repo, why: overrides[r.repo]?.hide ? "override: hide" : exclusion(r, login) ?? "" }));
  const awards = assignAwards(kept, honours, narrative, hackathonOrgs);
  const why: Record<string, string[]> = {};
  const projects = kept.map((r) => {
    const title = titleOf(r);
    const origin: Project["origin"] = r.fork ? "contrib" : hackathonOrgs.includes(r.owner) || /hackathon/i.test(r.readme.slice(0, 1500)) ? "hackathon" : /research/i.test(`${r.owner} ${r.topics.join(" ")}`) ? "research" : "personal";
    const [category, catWhy] = categorize(r);
    const ageDays = (now - Date.parse(r.pushedAt)) / DAY;
    const status: Project["status"] = r.archived ? "archived" : ageDays < 14 ? "active" : ageDays < 90 ? "recent" : origin === "hackathon" ? "shipped" : "dormant";
    // share and role count GitHub accounts only (REST contributors) when fetched, so agent or
    // unlinked commit authors do not turn a solo repo into a "team" one
    const people = r.contributors?.filter((c) => c.n > 0) ?? [];
    // a renamed or deleted account drops out of REST /contributors: count his commits back in
    if (people.length && !people.some((c) => me.has(c.login.toLowerCase())) && r.mine > 0) people.push({ login, n: r.mine });
    const peopleTotal = people.reduce((a, c) => a + c.n, 0);
    const mineCounted = people.find((c) => me.has(c.login.toLowerCase()))?.n ?? r.mine;
    const share = peopleTotal ? mineCounted / peopleTotal : r.commits ? r.mine / r.commits : 0;
    const top = [...people].sort((a, b) => b.n - a.n)[0];
    const role: Project["role"] = r.fork
      ? "contributor"
      : share >= 0.9 || people.length === 1
        ? "solo"
        : (top ? me.has(top.login.toLowerCase()) : share >= 0.5)
          ? "lead"
          : "team";
    const hit = awards[r.repo];
    const p: Project = {
      repo: r.repo,
      title,
      summary: summaryOf(r, title),
      category,
      origin,
      ...stackOf(r),
      year: new Date(r.created).getUTCFullYear(),
      created: r.created,
      pushedAt: r.pushedAt,
      status,
      role,
      share: Math.round(share * 100) / 100,
      commits: r.mine,
      stars: r.stars,
      award: hit && { place: hit.h.place, event: hit.h.event, when: hit.h.when, at: hit.h.at, sure: hit.sure },
      homepage: r.homepage || undefined,
      githubUrl: `https://github.com/${r.repo}`,
      score: 0,
      ...overrides[r.repo]?.set,
    };
    // rank: placements dominate, then stars, recency, his commit volume, polish
    p.score = Math.round(
      p.stars * 3 + (p.award ? (p.award.place.startsWith("1st") ? 40 : 25) : 0) + Math.max(0, 20 - ageDays / 9) + Math.min(15, r.mine / 10) + (r.description ? 5 : 0) + (r.homepage ? 3 : 0),
    );
    why[r.repo] = [`category ${catWhy}`, `status pushed ${Math.round(ageDays)}d ago`, `role ${Math.round(share * 100)}% of ${peopleTotal || r.commits} commits${people.length ? " (GitHub accounts)" : ""}`, hit ? `award ${hit.why}` : "", overrides[r.repo]?.set ? `override ${Object.keys(overrides[r.repo].set ?? {}).join(", ")}` : ""].filter(Boolean);
    return p;
  });
  projects.sort((a, b) => b.score - a.score || a.repo.localeCompare(b.repo));
  return { projects, skipped, why };
}
