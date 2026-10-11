// Tiny SEO/GEO surface for the web terminal. The page is a JS terminal (not crawlable),
// so we inject real meta + Person JSON-LD + a visually-hidden content block, and serve
// llms.txt / robots.txt / sitemap.xml — enough for search + AI crawlers to read who Jerry is.
import { profile } from "@/lib/profile";
import type { Project } from "@/lib/projects";

const ORIGIN = (process.env.PUBLIC_ORIGIN ?? "https://xiao.sh").replace(/\/$/, "");
const PAGE_TITLE = `${profile.name} — ${profile.role}`;
const DESC = `${profile.name} — ${profile.role}. CS @ ${profile.education}, based in ${profile.location}. Searchable projects, hackathon wins, and an AI you can ask about me — in a terminal UI right in the browser.`;

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const personLd = {
  "@context": "https://schema.org",
  "@type": "Person",
  name: profile.name,
  url: `${ORIGIN}/`,
  jobTitle: profile.role,
  alumniOf: { "@type": "CollegeOrUniversity", name: profile.education },
  homeLocation: profile.location,
  knowsAbout: profile.skills,
  sameAs: [profile.links.github, profile.links.linkedin],
  email: `mailto:${profile.links.email}`,
};

export const SEO_HEAD = `
<meta name="description" content="${esc(DESC)}" />
<link rel="canonical" href="${ORIGIN}/" />
<meta property="og:type" content="profile" />
<meta property="og:title" content="${esc(PAGE_TITLE)}" />
<meta property="og:description" content="${esc(DESC)}" />
<meta property="og:url" content="${ORIGIN}/" />
<meta name="twitter:card" content="summary" />
<script type="application/ld+json">${JSON.stringify(personLd)}</script>`;

const projectLabel = (p: Project) => (p.award ? ` (${p.award.place}, ${p.award.event})` : "");

export function seoBody(projects: Project[]): string {
  return `
<main class="seo-content">
  <h1>${esc(profile.name)}</h1>
  <p>${esc(profile.role)} · CS @ ${esc(profile.education)} · ${esc(profile.location)}</p>
  <p>${esc(DESC)}</p>
  <h2>Projects</h2>
  <ul>
    ${projects
      .map((p) => `<li>${p.githubUrl ? `<a href="${esc(p.githubUrl)}">${esc(p.title)}</a>` : esc(p.title)} — ${esc(p.summary)}${esc(projectLabel(p))}</li>`)
      .join("\n    ")}
  </ul>
  <h2>Elsewhere</h2>
  <ul>
    <li><a href="${esc(profile.links.github)}">GitHub</a></li>
    <li><a href="${esc(profile.links.linkedin)}">LinkedIn</a></li>
    <li><a href="mailto:${esc(profile.links.email)}">Email</a></li>
  </ul>
</main>`;
}

export function robotsTxt() {
  // explicitly welcome AI crawlers
  return [
    "User-agent: *",
    "Allow: /",
    "User-agent: GPTBot",
    "Allow: /",
    "User-agent: PerplexityBot",
    "Allow: /",
    "User-agent: Google-Extended",
    "Allow: /",
    "User-agent: ClaudeBot",
    "Allow: /",
    "",
    `Sitemap: ${ORIGIN}/sitemap.xml`,
    "",
  ].join("\n");
}

export function sitemapXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${ORIGIN}/</loc></url>
  <url><loc>${ORIGIN}/llms.txt</loc></url>
</urlset>
`;
}

export function llmsTxt(projects: Project[]) {
  return [
    `# ${profile.name}`,
    "",
    `> ${profile.role}. CS @ ${profile.education}, ${profile.location}.`,
    "",
    `${profile.name} is a CS student and builder. This site is a terminal UI that runs in the browser. Ask its built-in AI about projects, hackathon wins, and stack.`,
    "",
    "## Projects",
    ...projects.map((p) => `- ${p.githubUrl ? `[${p.title}](${p.githubUrl})` : p.title}: ${p.summary}${projectLabel(p)}`),
    "",
    "## Stack",
    `- ${profile.skills.join(", ")}`,
    "",
    "## Links",
    `- GitHub: ${profile.links.github}`,
    `- LinkedIn: ${profile.links.linkedin}`,
    `- Email: ${profile.links.email}`,
    "",
  ].join("\n");
}
