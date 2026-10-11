// The only hand-typed project data. Everything else on the Projects screen is derived from
// GitHub (+ LinkedIn honours) by src/lib/project-labels.ts. One line per wrong label:
//   "owner/repo": { set: { title: "Better Name" } }   // any derived field
//   "owner/repo": { hide: true }                       // drop a repo that passed the filter
//   "owner/repo": { show: true }                       // keep a repo the filter skipped
// Overrides apply at sync time and again whenever projects are read, so an edited line
// takes effect on the next deploy even before the daily refresh runs.
import type { ProjectOverride } from "@/lib/project-labels";

// where projects come from besides github.com/<profile login>: hackathon team orgs (their
// repos are labelled hackathon builds) and single extra repos
export const PROJECT_SOURCES = {
  hackathonOrgs: ["shlawgathon"],
  repos: ["Northeastern-Research-ORNL-1/pyreflect-interface"],
  // His commits are matched by author email. Older history in the team repos carries the
  // addresses and login of the account that GitHub no longer serves.
  authorEmails: ["jerry.x0930@gmail.com", "optifinecapemain@gmail.com", "152939329+undeemed@users.noreply.github.com"],
  formerLogins: ["undeemed"],
};

const LI = "?utm_source=share&utm_medium=member_desktop&rcm=ACoAAEerNM8BaiLwsyO2-11sjJzKRTO2VXWvfD4";
const post = (slug: string) => `https://www.linkedin.com/posts/xiaojerry_${slug}${LI}`;

export const PROJECT_OVERRIDES: Record<string, ProjectOverride> = {
  // LinkedIn lists the OceanTech win but no post names BlueDocs, so it cannot be matched
  "shlawgathon/BlueDocs": { set: { award: { place: "1st · Governance track", event: "OceanTech Hackathon", when: "Mar 2026", at: "2026-03-01", sure: true } } },
  "shlawgathon/Physical": { set: { title: "Physical.ai", linkedinUrl: post("within-24-hours-we-aritra-saharay-neil-activity-7421684534938767361-2Dxc"), eventUrl: "https://events.ycombinator.com/fullstackhackathon" } },
  "i098/pinger": { hide: true },
  // LinkedIn post + event pages: not on GitHub; the LinkedIn sync scrapes these posts
  "shlawgathon/interpreter": { set: { linkedinUrl: post("exploring-the-features-of-a-live-translator-activity-7431220415206744064-0h-U"), eventUrl: "https://luma.com/0xgxtpdt?tk=FJOJQR" } },
  "shlawgathon/WebBrain": { set: { linkedinUrl: post("i-had-lots-of-fun-at-the-mongodb-agentic-activity-7383038759665164288-yzTn"), eventUrl: "https://cerebralvalley.ai/e/mongoDB-hackathon?tab=guest-list" } },
  "shlawgathon/ICBG": { set: { linkedinUrl: post("last-night-we-aritra-saharay-wei-tu-and-activity-7406439444557443072-a_O6"), eventUrl: "https://luma.com/9ecbetao?tk=KZdXd4" } },
  "shlawgathon/productkit": { set: { linkedinUrl: post("github-shlawgathonproductkit-an-agentic-activity-7398606880346030080-OeHb"), eventUrl: "https://cerebralvalley.ai/e/bfl-hackathon?tab=guest-list" } },
  "shlawgathon/sportsclips": { set: { linkedinUrl: post("another-day-another-hackathon-shack15-activity-7385938406486437888-_u5O"), eventUrl: "https://cerebralvalley.ai/e/2025-ted-ai-hackathon?tab=guest-list" } },
};
