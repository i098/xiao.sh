import { readFile } from "node:fs/promises";
import path from "node:path";
import { profile } from "@/lib/profile";
import { projects } from "@/lib/projects";

export type LinkedInPost = {
  url: string;
  headline?: string;
  body?: string;
  excerpt?: string;
  publishedAt?: string;
  imageUrl?: string;
  videoUrl?: string;
  commentCount?: number;
};

export type LinkedInProfileSection = {
  title: string;
  items: string[];
};

export type LinkedInSnapshot = {
  profile: {
    name: string;
    title?: string;
    summary?: string;
    imageUrl?: string;
    location?: string;
    linkedinUrl: string;
    followerCount?: number;
    achievements?: string[];
    technologies?: string[];
    collaborators?: string[];
    narrative?: string[];
  };
  sections?: LinkedInProfileSection[];
  posts: LinkedInPost[];
  pulledAt: string;
  source?: string;
};

type CacheEntry = {
  data: LinkedInSnapshot;
  expiresAt: number;
};

const CACHE_TTL_MS = 30 * 1000;
const NOISE_PATTERNS = [
  /\bjoin linkedin\b/i,
  /\bsign in\b/i,
  /\bemail password\b/i,
  /\bby clicking agree\b/i,
  /\bskip to main content\b/i,
  /\bview .* full profile\b/i,
  /\bview .* full experience\b/i,
  /\bsee their title, tenure and more\b/i,
  /\bexplore more posts\b/i,
  /\bexplore top content\b/i,
  /\bothers named\b/i,
  /\badd new skills\b/i,
];
const SUMMARY_BANNED_PHRASES = [
  /i build clean, product-driven systems across ai and full-stack engineering\.?/i,
];
const SECTION_ALLOWLIST = new Set([
  "About",
  "Experience",
  "Education",
  "Skills",
  "Certifications",
  "Projects",
  "Publications",
  "Honors & Awards",
  "Courses",
  "Languages",
  "Interests",
  "Volunteer Experience",
]);

let cacheEntry: CacheEntry | null = null;
let inFlight: Promise<LinkedInSnapshot> | null = null;

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function clipText(value: string, max = 220) {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function canonicalKey(value: string) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isNoiseLine(value: string) {
  if (!value) return true;
  return NOISE_PATTERNS.some((pattern) => pattern.test(value));
}

function sanitizeSummary(value: string) {
  let result = normalizeText(value);
  for (const pattern of SUMMARY_BANNED_PHRASES) {
    result = result.replace(pattern, "").trim();
  }
  result = result.replace(/\s{2,}/g, " ").trim();
  return result;
}

function dedupeTextList(
  values: string[],
  options: { maxLen?: number; limit?: number } = {},
) {
  const seen = new Set<string>();
  const out: string[] = [];
  const maxLen = options.maxLen ?? 220;
  const limit = options.limit ?? 50;

  for (const raw of values) {
    const normalized = normalizeText(raw);
    if (!normalized || isNoiseLine(normalized)) continue;
    const clipped = clipText(normalized, maxLen);
    const key = canonicalKey(clipped);
    if (!key || seen.has(key)) continue;

    const nearDuplicate = out.some((existing) => {
      const existingKey = canonicalKey(existing);
      if (!existingKey) return false;
      if (key === existingKey) return true;
      if (key.length < 20 || existingKey.length < 20) return false;
      return key.includes(existingKey) || existingKey.includes(key);
    });

    if (nearDuplicate) continue;

    seen.add(key);
    out.push(clipped);
    if (out.length >= limit) break;
  }

  return out;
}

function normalizeSectionTitle(title: string) {
  const key = canonicalKey(title);
  if (!key) return "";

  const known: Record<string, string> = {
    about: "About",
    experience: "Experience",
    "experience education": "Experience",
    education: "Education",
    skills: "Skills",
    certifications: "Certifications",
    "licenses certifications": "Certifications",
    licenses: "Certifications",
    projects: "Projects",
    publications: "Publications",
    "honors awards": "Honors & Awards",
    courses: "Courses",
    languages: "Languages",
    interests: "Interests",
    "volunteer experience": "Volunteer Experience",
  };

  if (known[key]) return known[key];
  return title
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function sanitizeNarrative(values: string[], achievements: string[]) {
  const base = dedupeTextList(values, { maxLen: 180, limit: 8 }).filter((line) => {
    return !/^recent result:/i.test(line) && !/^frequent stack:/i.test(line);
  });

  const achievementKeys = new Set(achievements.map((line) => canonicalKey(line)));
  return base.filter((line) => !achievementKeys.has(canonicalKey(line))).slice(0, 6);
}

function fallbackSnapshot(): LinkedInSnapshot {
  return {
    profile: {
      name: profile.name,
      title: profile.role,
      summary: profile.bio,
      linkedinUrl: profile.links.linkedin,
      location: profile.location,
      achievements: [],
      technologies: profile.skills,
      collaborators: [],
      narrative: [],
    },
    sections: [],
    posts: projects
      .map((project) => project.linkedinUrl)
      .filter((url): url is string => Boolean(url))
      .map((url) => ({ url })),
    pulledAt: new Date().toISOString(),
    source: "fallback",
  };
}

function normalizeSnapshot(raw: unknown) {
  if (!raw || typeof raw !== "object") return fallbackSnapshot();
  const value = raw as Partial<LinkedInSnapshot>;

  const rawAchievements = Array.isArray(value.profile?.achievements)
    ? value.profile.achievements.filter((item): item is string => typeof item === "string")
    : [];
  const rawTechnologies = Array.isArray(value.profile?.technologies)
    ? value.profile.technologies.filter((item): item is string => typeof item === "string")
    : [];
  const rawCollaborators = Array.isArray(value.profile?.collaborators)
    ? value.profile.collaborators.filter((item): item is string => typeof item === "string")
    : [];
  const rawNarrative = Array.isArray(value.profile?.narrative)
    ? value.profile.narrative.filter((item): item is string => typeof item === "string")
    : [];

  const achievements = dedupeTextList(rawAchievements, { maxLen: 180, limit: 6 });
  const technologies = dedupeTextList(rawTechnologies, { maxLen: 40, limit: 18 }).filter((item) => {
    if (/^kotlin$/i.test(item)) return false;
    if (/^llama$/i.test(item)) return false;
    if (/^fireworks(\s*ai|\.js)?$/i.test(item)) return false;
    if (/^three\.?js$/i.test(item)) return false;
    return true;
  });
  const collaborators = dedupeTextList(rawCollaborators, { maxLen: 40, limit: 16 });
  const narrative = sanitizeNarrative(rawNarrative, achievements);

  const sections = Array.isArray(value.sections)
    ? value.sections
        .filter((section) => section && typeof section === "object")
        .map((section) => {
          const item = section as Partial<LinkedInProfileSection>;
          const title = normalizeSectionTitle(typeof item.title === "string" ? item.title : "");
          const items = Array.isArray(item.items)
            ? dedupeTextList(
                item.items.filter((entry): entry is string => typeof entry === "string"),
                { maxLen: 220, limit: 20 },
              )
            : [];

          return { title, items } satisfies LinkedInProfileSection;
        })
        .filter((section) => SECTION_ALLOWLIST.has(section.title))
        .filter((section) => section.title.length > 0 && section.items.length > 0)
    : [];

  const snapshot: LinkedInSnapshot = {
    profile: {
      name:
        typeof value.profile?.name === "string" && value.profile.name.trim().length > 0
          ? value.profile.name
          : profile.name,
      title: typeof value.profile?.title === "string" ? value.profile.title : profile.role,
      summary:
        typeof value.profile?.summary === "string"
          ? sanitizeSummary(value.profile.summary) || profile.bio
          : profile.bio,
      imageUrl: typeof value.profile?.imageUrl === "string" ? value.profile.imageUrl : undefined,
      location: typeof value.profile?.location === "string" ? value.profile.location : profile.location,
      linkedinUrl:
        typeof value.profile?.linkedinUrl === "string"
          ? value.profile.linkedinUrl
          : profile.links.linkedin,
      followerCount:
        typeof value.profile?.followerCount === "number" ? value.profile.followerCount : undefined,
      achievements,
      technologies,
      collaborators,
      narrative,
    },
    sections,
    posts: Array.isArray(value.posts)
      ? value.posts
          .filter((post) => post && typeof post === "object")
          .map((post) => {
            const item = post as Partial<LinkedInPost>;
            return {
              url: typeof item.url === "string" ? item.url : "",
              headline:
                typeof item.headline === "string"
                  ? clipText(normalizeText(item.headline), 150)
                  : undefined,
              body:
                typeof item.body === "string"
                  ? clipText(normalizeText(item.body), 600)
                  : undefined,
              excerpt:
                typeof item.excerpt === "string"
                  ? clipText(normalizeText(item.excerpt), 220)
                  : undefined,
              publishedAt: typeof item.publishedAt === "string" ? item.publishedAt : undefined,
              imageUrl: typeof item.imageUrl === "string" ? item.imageUrl : undefined,
              videoUrl: typeof item.videoUrl === "string" ? item.videoUrl : undefined,
              commentCount: typeof item.commentCount === "number" ? item.commentCount : undefined,
            } satisfies LinkedInPost;
          })
          .filter((post) => post.url.length > 0)
          .filter((post) => !(post.headline && isNoiseLine(post.headline)))
      : [],
    pulledAt:
      typeof value.pulledAt === "string" && value.pulledAt.length > 0
        ? value.pulledAt
        : new Date().toISOString(),
    source: typeof value.source === "string" ? value.source : undefined,
  };

  return snapshot;
}

async function loadLinkedInSnapshotFile() {
  const filePath = path.join(process.cwd(), "src", "data", "linkedin-about.json");
  const raw = await readFile(filePath, "utf8");
  return normalizeSnapshot(JSON.parse(raw));
}

export async function getLinkedInSnapshot() {
  const now = Date.now();
  if (cacheEntry && cacheEntry.expiresAt > now) {
    return cacheEntry.data;
  }

  if (inFlight) return inFlight;

  inFlight = loadLinkedInSnapshotFile()
    .catch(() => fallbackSnapshot())
    .then((data) => {
      cacheEntry = {
        data,
        expiresAt: Date.now() + CACHE_TTL_MS,
      };
      return data;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
