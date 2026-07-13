import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrowserContext, chromium } from "playwright";
import { profile } from "../src/lib/profile";
import { projects } from "../src/lib/projects";

type RawPost = {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  headline?: string;
  articleBody?: string;
  publishedAt?: string;
  commentCount?: number;
  videoUrl?: string;
  thumbnailUrl?: string;
  authorName?: string;
  authorUrl?: string;
  authorImage?: string;
  followerCount?: number;
};

type LinkedInSnapshot = {
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
  sections?: Array<{
    title: string;
    items: string[];
  }>;
  posts: Array<{
    url: string;
    headline?: string;
    body?: string;
    excerpt?: string;
    publishedAt?: string;
    imageUrl?: string;
    videoUrl?: string;
    commentCount?: number;
  }>;
  pulledAt: string;
  source: "playwright";
};

type ProfileSection = {
  title: string;
  items: string[];
};

type ScrapedProfileDetails = {
  name?: string;
  headline?: string;
  location?: string;
  about?: string;
  sections: ProfileSection[];
  authWall: boolean;
};

const DETAIL_SECTION_PATHS: Array<{ slug: string; title: string }> = [
  { slug: "experience", title: "Experience" },
  { slug: "education", title: "Education" },
  { slug: "skills", title: "Skills" },
  { slug: "certifications", title: "Certifications" },
  { slug: "projects", title: "Projects" },
  { slug: "languages", title: "Languages" },
  { slug: "publications", title: "Publications" },
  { slug: "honors", title: "Honors & Awards" },
  { slug: "courses", title: "Courses" },
  { slug: "interests", title: "Interests" },
  { slug: "volunteering-experiences", title: "Volunteer Experience" },
];

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_CLEAN_DEFAULT_MODELS = [
  "liquid/lfm-2.5-1.2b-instruct:free",
];
const OPENROUTER_CLEAN_TIMEOUT_MS = 35_000;
const OPENROUTER_MODELS_TIMEOUT_MS = 9_000;
const OPENROUTER_CLEAN_MODELS_LIMIT = 3;
const OPENROUTER_CLEAN_MAX_ATTEMPTS = 3;

function cleanTitle(title: string | undefined) {
  if (!title) return undefined;
  return title.replace(/\s*\|\s*LinkedIn\s*$/i, "").trim();
}

function clip(text: string | undefined, max = 280) {
  if (!text) return undefined;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max).trimEnd()}...`;
}

function envFlag(name: string, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

async function waitForEnter(prompt: string) {
  process.stdout.write(`${prompt}\n`);
  await new Promise<void>((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", () => resolve());
  });
}

type OpenRouterChoice = {
  message?: { content?: string };
};

type OpenRouterResponse = {
  choices?: OpenRouterChoice[];
  error?: { message?: string };
};

type OpenRouterModel = {
  id?: string;
  name?: string;
  created?: number;
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing?: {
    prompt?: string;
    completion?: string;
    request?: string;
  };
};

type OpenRouterModelsResponse = {
  data?: OpenRouterModel[];
};

function normalizeText(value: string | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function safeClip(value: string | undefined, max = 220) {
  const text = normalizeText(value);
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function pickSectionItems(sections: ProfileSection[], title: string, limit = 20) {
  const items = sections.find((section) => section.title.toLowerCase() === title.toLowerCase())?.items ?? [];
  return uniqueCaseInsensitive(items.map((item) => safeClip(item, 170)).filter(Boolean)).slice(0, limit);
}

function sectionOrder(title: string) {
  const normalized = title.toLowerCase();
  if (normalized === "experience") return 0;
  if (normalized === "education") return 1;
  if (normalized === "certifications") return 2;
  if (normalized === "languages") return 3;
  if (normalized === "skills") return 4;
  return 10;
}

function extractJsonObject(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace < 0 || lastBrace <= firstBrace) return null;
  return candidate.slice(firstBrace, lastBrace + 1);
}

function parseAiSections(raw: unknown) {
  if (!Array.isArray(raw)) return [];

  const normalized = raw
    .filter((section) => section && typeof section === "object")
    .map((section) => {
      const value = section as { title?: unknown; items?: unknown };
      const title = normalizeText(typeof value.title === "string" ? value.title : "");
      const items = Array.isArray(value.items)
        ? value.items
            .filter((item): item is string => typeof item === "string")
            .map((item) => safeClip(item, 220))
            .filter(Boolean)
        : [];
      return { title, items } as ProfileSection;
    })
    .filter((section) => section.title.length > 0 && section.items.length > 0);

  const merged = new Map<string, ProfileSection>();
  for (const section of normalized) {
    const key = section.title.toLowerCase();
    const current = merged.get(key) ?? { title: section.title, items: [] };
    current.items = uniqueCaseInsensitive([...current.items, ...section.items]).slice(0, 20);
    merged.set(key, current);
  }

  return [...merged.values()].sort((a, b) => sectionOrder(a.title) - sectionOrder(b.title));
}

function parseAiStringList(raw: unknown, max = 12, clipAt = 60) {
  if (!Array.isArray(raw)) return [];
  return uniqueCaseInsensitive(
    raw
      .filter((item): item is string => typeof item === "string")
      .map((item) => safeClip(item, clipAt))
      .filter(Boolean),
  ).slice(0, max);
}

function compactUrl(value: string | undefined, max = 220) {
  if (!value) return "";

  try {
    const parsed = new URL(value);
    parsed.search = "";
    parsed.hash = "";
    return safeClip(parsed.toString(), max);
  } catch {
    return safeClip(value, max);
  }
}

function canonicalPostUrl(value: string | undefined) {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}

function parseCsvList(value: string | undefined) {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function toNumber(value: string | number | undefined) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  return Number.parseFloat(value);
}

function isFreeModel(model: OpenRouterModel) {
  const promptCost = toNumber(model.pricing?.prompt);
  const completionCost = toNumber(model.pricing?.completion);
  const requestCost = toNumber(model.pricing?.request);

  const costsAreZero =
    (Number.isNaN(promptCost) || promptCost === 0) &&
    (Number.isNaN(completionCost) || completionCost === 0) &&
    (Number.isNaN(requestCost) || requestCost === 0);

  return costsAreZero || model.id?.endsWith(":free") === true;
}

function supportsTextIO(model: OpenRouterModel) {
  const input = model.architecture?.input_modalities;
  const output = model.architecture?.output_modalities;

  if (!input && !output) return true;
  const inputText = !input || input.includes("text");
  const outputText = !output || output.includes("text");
  return inputText && outputText;
}

function getModelScore(model: OpenRouterModel) {
  const id = `${model.id ?? ""} ${model.name ?? ""}`.toLowerCase();
  const created = model.created ?? 0;
  const contextLength = model.context_length ?? 0;

  let score = 0;
  if (id.includes("gpt-oss")) score += 30;
  if (id.includes("qwen3")) score += 24;
  if (id.includes("llama-4")) score += 22;
  if (id.includes("kimi-k2")) score += 22;
  if (id.includes("deepseek-r1") || id.includes("deepseek-v3")) score += 20;
  if (id.includes("gemini-2.5")) score += 18;
  if (id.includes("mistral") || id.includes("command-r")) score += 12;
  if (id.includes(":free")) score += 4;

  score += Math.min(12, Math.log2(Math.max(1, contextLength / 8192 + 1)) * 4);
  score += Math.min(8, created / 1000000000);
  return score;
}

async function fetchDynamicCleanupModels(apiKey: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENROUTER_MODELS_TIMEOUT_MS);

  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) return [];

    const data = (await response.json()) as OpenRouterModelsResponse;
    return (data.data ?? [])
      .filter((model) => Boolean(model.id))
      .filter(isFreeModel)
      .filter(supportsTextIO)
      .sort((a, b) => getModelScore(b) - getModelScore(a))
      .map((model) => model.id as string)
      .slice(0, OPENROUTER_CLEAN_MODELS_LIMIT);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function getCleanupModels(apiKey: string) {
  const envModels = parseCsvList(process.env.OPENROUTER_CLEAN_MODELS);
  const legacyModel = process.env.OPENROUTER_CLEAN_MODEL?.trim();

  let dynamicModels: string[] = [];
  if (envFlag("OPENROUTER_CLEAN_DYNAMIC_MODELS", false)) {
    dynamicModels = await fetchDynamicCleanupModels(apiKey);
  }

  return uniqueStrings([
    ...envModels,
    legacyModel ?? "",
    ...OPENROUTER_CLEAN_DEFAULT_MODELS,
    ...dynamicModels,
  ]).slice(0, OPENROUTER_CLEAN_MODELS_LIMIT);
}

function normalizeCleanedSnapshot(raw: unknown, fallback: LinkedInSnapshot): LinkedInSnapshot {
  if (!raw || typeof raw !== "object") return fallback;
  const value = raw as {
    profile?: {
      name?: unknown;
      title?: unknown;
      summary?: unknown;
      location?: unknown;
      imageUrl?: unknown;
      linkedinUrl?: unknown;
      followerCount?: unknown;
      technologies?: unknown;
    };
    sections?: unknown;
    posts?: unknown;
  };

  const sections = parseAiSections(value.sections);
  const technologies = parseAiStringList(value.profile?.technologies, 14, 40);
  const fallbackPostsByUrl = new Map<string, LinkedInSnapshot["posts"][number]>();
  for (const post of fallback.posts) {
    fallbackPostsByUrl.set(canonicalPostUrl(post.url), post);
  }

  const posts: LinkedInSnapshot["posts"] = Array.isArray(value.posts)
    ? value.posts
        .filter((post) => post && typeof post === "object")
        .reduce<LinkedInSnapshot["posts"]>((acc, post) => {
          const item = post as {
            url?: unknown;
            headline?: unknown;
            excerpt?: unknown;
            publishedAt?: unknown;
            imageUrl?: unknown;
            videoUrl?: unknown;
            commentCount?: unknown;
          };

          const url = typeof item.url === "string" ? item.url.trim() : "";
          if (!url) return acc;
          const fallbackPost = fallbackPostsByUrl.get(canonicalPostUrl(url));

          const cleanedPost: LinkedInSnapshot["posts"][number] = { url };
          if (typeof item.headline === "string" && item.headline.trim().length > 0) {
            cleanedPost.headline = safeClip(item.headline, 140);
          }
          if (typeof item.excerpt === "string" && item.excerpt.trim().length > 0) {
            cleanedPost.excerpt = safeClip(item.excerpt, 220);
          }
          if (typeof item.publishedAt === "string" && item.publishedAt.trim().length > 0) {
            cleanedPost.publishedAt = item.publishedAt;
          } else if (fallbackPost?.publishedAt) {
            cleanedPost.publishedAt = fallbackPost.publishedAt;
          }
          if (typeof item.imageUrl === "string" && item.imageUrl.trim().length > 0) {
            cleanedPost.imageUrl = item.imageUrl;
          }
          if (typeof item.videoUrl === "string" && item.videoUrl.trim().length > 0) {
            cleanedPost.videoUrl = item.videoUrl;
          }
          if (typeof item.commentCount === "number" && Number.isFinite(item.commentCount)) {
            cleanedPost.commentCount = item.commentCount;
          }

          acc.push(cleanedPost);
          return acc;
        }, [])
        .slice(0, 12)
    : fallback.posts;

  return {
    profile: {
      name:
        typeof value.profile?.name === "string" && value.profile.name.trim().length > 0
          ? safeClip(value.profile.name, 80)
          : fallback.profile.name,
      title:
        typeof value.profile?.title === "string" && value.profile.title.trim().length > 0
          ? safeClip(value.profile.title, 120)
          : fallback.profile.title,
      summary:
        typeof value.profile?.summary === "string" && value.profile.summary.trim().length > 0
          ? safeClip(value.profile.summary, 260)
          : fallback.profile.summary,
      imageUrl:
        fallback.profile.imageUrl,
      location:
        typeof value.profile?.location === "string" && value.profile.location.trim().length > 0
          ? safeClip(value.profile.location, 80)
          : fallback.profile.location,
      linkedinUrl:
        fallback.profile.linkedinUrl,
      followerCount:
        typeof value.profile?.followerCount === "number"
          ? value.profile.followerCount
          : fallback.profile.followerCount,
      achievements: fallback.profile.achievements,
      technologies: technologies.length > 0 ? technologies : fallback.profile.technologies,
      collaborators: [],
      narrative: [],
    },
    sections: sections.length > 0 ? sections : fallback.sections,
    posts: posts.length > 0 ? posts : fallback.posts,
    pulledAt: fallback.pulledAt,
    source: fallback.source,
  };
}

function buildOpenRouterCleanupInput(snapshot: LinkedInSnapshot) {
  const sections = snapshot.sections ?? [];
  return {
    profile: {
      name: snapshot.profile.name,
      title: snapshot.profile.title,
      summary: snapshot.profile.summary,
      location: snapshot.profile.location,
      followerCount: snapshot.profile.followerCount,
      technologies: snapshot.profile.technologies ?? [],
    },
    sections: [
      {
        title: "Experience",
        items: pickSectionItems(sections, "Experience", 6),
      },
      {
        title: "Education",
        items: pickSectionItems(sections, "Education", 6),
      },
      {
        title: "Certifications",
        items: pickSectionItems(sections, "Certifications", 6),
      },
      {
        title: "Languages",
        items: pickSectionItems(sections, "Languages", 6),
      },
      {
        title: "Skills",
        items: pickSectionItems(sections, "Skills", 6),
      },
    ].filter((section) => section.items.length > 0),
    posts: snapshot.posts.slice(0, 3).map((post) => ({
      url: compactUrl(post.url, 180),
      headline: safeClip(post.headline, 120),
      excerpt: safeClip(post.excerpt ?? post.body, 140),
    })),
  };
}

async function cleanSnapshotWithOpenRouter(snapshot: LinkedInSnapshot) {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return snapshot;
  if (envFlag("OPENROUTER_CLEAN_LINKEDIN", true) === false) return snapshot;

  const models = await getCleanupModels(apiKey);
  if (models.length === 0) return snapshot;
  const input = buildOpenRouterCleanupInput(snapshot);

  const systemPrompt = [
    "You clean scraped LinkedIn data into concise JSON for a portfolio.",
    "Return strict JSON only. No markdown, no prose.",
    "Output schema:",
    "{",
    '  "profile": {',
    '    "name": string, "title": string, "summary": string, "location": string, "imageUrl": string, "linkedinUrl": string, "followerCount": number, "technologies": string[]',
    "  },",
    '  "sections": [{ "title": string, "items": string[] }],',
    '  "posts": [{ "url": string, "headline": string, "excerpt": string }]',
    "}",
    "Rules:",
    "- Keep only meaningful, deduplicated entries.",
    "- Prioritize sections: Experience, Education, Certifications, Languages, Skills.",
    "- For section items keep concise one-line entries.",
    "- Remove CTA noise like 'Show credential' and duplicated phrases.",
    "- Keep at most 6 items per section.",
    "- Keep at most 3 posts.",
    "- Summary must be concise and specific (max 1 sentence).",
    "- Return compact minified JSON only, with no markdown and no explanatory text.",
  ].join("\n");

  const totalAttempts = Math.max(OPENROUTER_CLEAN_MAX_ATTEMPTS, models.length);
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    const model = models[attempt % models.length];
    if (!model) continue;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPENROUTER_CLEAN_TIMEOUT_MS);

    try {
      const response = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
          "X-Title": process.env.OPENROUTER_SITE_NAME ?? "xiao.sh",
        },
        body: JSON.stringify({
          model,
          provider: {
            allow_fallbacks: true,
            data_collection: "allow",
          },
          temperature: 0,
          max_tokens: 900,
          stream: false,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(input) },
          ],
        }),
        signal: controller.signal,
      });

      const data = (await response.json()) as OpenRouterResponse;
      if (!response.ok || data.error) {
        const message = data.error?.message ?? `OpenRouter cleanup failed (${response.status}).`;
        console.warn(`OpenRouter cleanup failed with ${model}: ${message}`);
        continue;
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content || typeof content !== "string") {
        console.warn(`OpenRouter cleanup failed with ${model}: empty content`);
        continue;
      }

      const jsonText = extractJsonObject(content);
      if (!jsonText) {
        console.warn(`OpenRouter cleanup failed with ${model}: no JSON payload`);
        continue;
      }

      try {
        const parsed = JSON.parse(jsonText) as unknown;
        return normalizeCleanedSnapshot(parsed, snapshot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (envFlag("OPENROUTER_CLEAN_DEBUG", false)) {
          const debugDir = path.join(process.cwd(), "src", "data");
          await mkdir(debugDir, { recursive: true });
          await writeFile(path.join(debugDir, "linkedin-cleanup-debug.txt"), content, "utf8");
        }
        console.warn(`OpenRouter cleanup failed with ${model}: invalid JSON (${message})`);
        continue;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`OpenRouter cleanup failed with ${model}: ${message}`);
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }

  return snapshot;
}

async function applyLinkedInAuthCookies(context: BrowserContext) {
  const liAt = process.env.LINKEDIN_COOKIE_LI_AT?.trim();
  const jsessionIdRaw = process.env.LINKEDIN_COOKIE_JSESSIONID?.trim();
  const jsessionId = jsessionIdRaw
    ? jsessionIdRaw.startsWith("\"") && jsessionIdRaw.endsWith("\"")
      ? jsessionIdRaw
      : `"${jsessionIdRaw.replace(/^"+|"+$/g, "")}"`
    : undefined;
  const cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly?: boolean;
    sameSite?: "None" | "Lax" | "Strict";
  }> = [];

  if (liAt) {
    cookies.push({
      name: "li_at",
      value: liAt,
      domain: ".linkedin.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "None",
    });
  }

  if (jsessionId) {
    cookies.push({
      name: "JSESSIONID",
      value: jsessionId,
      domain: ".linkedin.com",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "None",
    });
  }

  if (cookies.length > 0) {
    await context.addCookies(cookies);
    console.log("applied LinkedIn auth cookies");
  } else {
    console.log("no LinkedIn auth cookies found, using public profile access");
  }
}

function uniqueCaseInsensitive(values: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed
      .toLowerCase()
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }

  return out;
}

function splitSentences(text: string | undefined) {
  if (!text) return [];
  return text
    .replace(/\r/g, "\n")
    .split(/[.!?]\s+|\n+/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

async function readProfileDetails(page: Awaited<ReturnType<BrowserContext["newPage"]>>, url: string) {
  let lastDetails: ScrapedProfileDetails = {
    name: undefined,
    headline: undefined,
    location: undefined,
    about: undefined,
    sections: [],
    authWall: true,
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2400);

    for (let i = 0; i < 8; i += 1) {
      await page.mouse.wheel(0, 1800);
      await page.waitForTimeout(280);
    }

    const details = await page.evaluate<ScrapedProfileDetails>(() => {
    const normalize = (value: string | null | undefined) =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const normalizeKey = (value: string) =>
      value
        .toLowerCase()
        .replace(/[’']/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

    const dedupe = (values: string[]) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const value of values) {
        const trimmed = normalize(value);
        if (!trimmed) continue;
        const key = normalizeKey(trimmed);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
      }
      return out;
    };

    const main = document.querySelector("main") ?? document.body;
    const path = window.location.pathname.toLowerCase();
    const authWall = path.includes("/authwall");

    const name = normalize(main.querySelector("h1")?.textContent);

    const headlineCandidates = dedupe(
      Array.from(main.querySelectorAll("div, span, h2"))
        .map((element) => normalize((element as HTMLElement).innerText ?? element.textContent))
        .filter((text) => text.length > 12 && text.length < 180),
    );

    const headline = headlineCandidates.find((line) => {
      if (!line) return false;
      if (name && line === name) return false;
      return (
        /\b(engineer|developer|student|builder|founder|research|software|ai|product)\b/i.test(line) ||
        line.includes("+")
      );
    });

    const topCard = main.querySelector("section") ?? main;
    const location = dedupe(
      Array.from(topCard.querySelectorAll("span, div"))
        .map((element) => normalize((element as HTMLElement).innerText ?? element.textContent))
        .filter((text) => text.length > 3 && text.length < 80),
    ).find((line) => {
      return (
        /\b(area|city|state|united states|boston|san francisco|new york|california|massachusetts)\b/i.test(
          line,
        ) || /,\s*[A-Z]{2}$/.test(line)
      );
    });

    const sections = Array.from(main.querySelectorAll("section"))
      .map((section) => {
        const title = normalize(
          section.querySelector("h2 span[aria-hidden='true'], h2 span, h2, h3")?.textContent,
        );
        if (!title || title.length > 120) return null;
        if (
          /\b(people also viewed|you may know|similar profiles|ads|discover more|newsletters)\b/i.test(
            title,
          )
        ) {
          return null;
        }

        const listItems = Array.from(section.querySelectorAll("li"))
          .map((item) => normalize((item as HTMLElement).innerText ?? item.textContent))
          .map((item) => item.replace(/\s*\n+\s*/g, " • "))
          .map((item) => item.replace(/\s+/g, " ").trim())
          .filter((item) => item.length > 1 && item.toLowerCase() !== title.toLowerCase())
          .map((item) => (item.length > 420 ? `${item.slice(0, 417)}...` : item));

        const paragraphItems = Array.from(section.querySelectorAll("p"))
          .map((item) => normalize((item as HTMLElement).innerText ?? item.textContent))
          .filter((item) => item.length > 1 && item.toLowerCase() !== title.toLowerCase())
          .map((item) => (item.length > 420 ? `${item.slice(0, 417)}...` : item));

        const items = dedupe(listItems.length > 0 ? listItems : paragraphItems).slice(0, 25);
        if (items.length === 0) return null;
        return { title, items };
      })
      .filter((section): section is ProfileSection => Boolean(section));

    const about = sections.find((section) => /^about$/i.test(section.title))?.items[0];

    return {
      name: name || undefined,
      headline: headline || undefined,
      location: location || undefined,
      about: about || undefined,
      sections,
      authWall,
    };
    });

    lastDetails = details;
    if (!details.authWall) return details;

    await page.waitForTimeout(900 * (attempt + 1));
  }

  return lastDetails;
}

function normalizeLinkedInProfileUrl(url: string) {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  let pathname = parsed.pathname;
  if (!pathname.endsWith("/")) pathname += "/";
  parsed.pathname = pathname;
  return parsed.toString();
}

function mergeSections(...sectionGroups: ProfileSection[][]) {
  const byTitle = new Map<string, ProfileSection>();

  for (const group of sectionGroups) {
    for (const section of group) {
      const title = section.title.trim();
      if (!title) continue;

      const current = byTitle.get(title) ?? { title, items: [] };
      const combined = uniqueCaseInsensitive([...current.items, ...section.items]);
      byTitle.set(title, {
        title,
        items: combined.slice(0, 40),
      });
    }
  }

  return [...byTitle.values()];
}

function hasSections(sections: LinkedInSnapshot["sections"] | undefined) {
  if (!sections || sections.length === 0) return false;
  return sections.some((section) => section.items.length > 0);
}

async function readExistingSnapshot(outputPath: string) {
  try {
    const raw = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw) as LinkedInSnapshot;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readDetailSections(
  page: Awaited<ReturnType<BrowserContext["newPage"]>>,
  profileUrl: string,
) {
  const baseProfileUrl = normalizeLinkedInProfileUrl(profileUrl);
  const sections: ProfileSection[] = [];

  for (const detail of DETAIL_SECTION_PATHS) {
    const detailUrl = `${baseProfileUrl}details/${detail.slug}/`;

    try {
      await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(1400);

      const result = await page.evaluate(() => {
        const normalize = (value: string | null | undefined) =>
          (value ?? "").replace(/\s+/g, " ").trim();

        const normalizeKey = (value: string) =>
          value
            .toLowerCase()
            .replace(/[’']/g, "")
            .replace(/[^a-z0-9]+/g, " ")
            .trim();

        const dedupe = (values: string[]) => {
          const seen = new Set<string>();
          const out: string[] = [];
          for (const value of values) {
            const trimmed = normalize(value);
            if (!trimmed) continue;
            const key = normalizeKey(trimmed);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(trimmed);
          }
          return out;
        };

        const path = window.location.pathname.toLowerCase();
        const authWall = path.includes("/authwall");
        if (authWall) return { authWall, items: [] as string[] };

        const main = document.querySelector("main");
        if (!main) return { authWall: false, items: [] as string[] };

        const items = dedupe(
          Array.from(main.querySelectorAll("li"))
            .map((item) => normalize((item as HTMLElement).innerText ?? item.textContent))
            .map((item) => item.replace(/\s*\n+\s*/g, " • "))
            .map((item) => item.replace(/\s+/g, " ").trim())
            .filter((item) => item.length > 1)
            .map((item) => (item.length > 420 ? `${item.slice(0, 417)}...` : item)),
        ).slice(0, 50);

        return { authWall: false, items };
      });

      if (result.authWall) {
        console.warn(
          `detail page ${detail.slug} hit authwall; add LINKEDIN_COOKIE_LI_AT to capture full profile`,
        );
        continue;
      }

      if (result.items.length > 0) {
        sections.push({
          title: detail.title,
          items: result.items,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`failed detail section ${detail.slug}: ${message}`);
    }
  }

  return sections;
}

function extractAchievements(posts: RawPost[], extraSources: string[] = []) {
  const achievementSignals = /\b(placing|placed|winner|won|finalist|top\s*\d+|1st|2nd|3rd)\b/i;
  const picked: string[] = [];

  for (const post of posts) {
    const lines = splitSentences([post.headline, post.articleBody, post.description].filter(Boolean).join(". "));
    const match = lines.find((line) => achievementSignals.test(line));
    if (!match) continue;
    picked.push(clip(match, 180) ?? match);
  }

  for (const source of extraSources) {
    const lines = splitSentences(source);
    const match = lines.find((line) => achievementSignals.test(line));
    if (!match) continue;
    picked.push(clip(match, 180) ?? match);
  }

  return uniqueCaseInsensitive(picked).slice(0, 8);
}

function normalizeNameCandidate(value: string) {
  const cleaned = value
    .replace(/\([^)]*\)/g, "")
    .replace(/\b(?:and|with|my|teammates?|friends|we|i)\b/gi, " ")
    .replace(/[|/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^A-Za-z]+|[^A-Za-z.' -]+$/g, "");

  if (!cleaned) return null;
  if (/https?:\/\//i.test(cleaned)) return null;
  if (cleaned.length < 2 || cleaned.length > 40) return null;
  if (/\b(hackathon|github|linkedin|event|repo|video|special|sponsor)\b/i.test(cleaned)) return null;
  if (!/^[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3}$/.test(cleaned)) return null;

  return cleaned;
}

function parseNameList(input: string) {
  return input
    .replaceAll("&", ",")
    .replace(/\band\b/gi, ",")
    .split(",")
    .map((part) => normalizeNameCandidate(part))
    .filter((name): name is string => Boolean(name));
}

function extractCollaborators(posts: RawPost[], extraSources: string[] = []) {
  const names: string[] = [];

  const sources = [
    ...posts.map((post) => `${post.headline ?? ""}\n${post.articleBody ?? ""}\n${post.description ?? ""}`),
    ...extraSources,
  ];

  const patterns = [
    /\bwe\s*\(([^)]+)\)/gi,
    /\bwith my friends\s+([^\n]+)/gi,
    /\bteammates?,\s*([^\n]+)/gi,
  ];

  for (const source of sources) {
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const group = match[1];
        if (!group) continue;
        names.push(...parseNameList(group));
      }
    }
  }

  return uniqueCaseInsensitive(names)
    .filter((name) => !/\b(jerry|xiao)\b/i.test(name))
    .slice(0, 12);
}

const TECHNOLOGY_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "TypeScript", regex: /\btypescript\b/i },
  { label: "JavaScript", regex: /\bjavascript\b/i },
  { label: "Python", regex: /\bpython\b/i },
  { label: "Java", regex: /\bjava\b/i },
  { label: "Swift", regex: /\bswift\b/i },
  { label: "React", regex: /\breact\b/i },
  { label: "Next.js", regex: /\bnext\.?js\b/i },
  { label: "Tailwind CSS", regex: /\btailwind\b/i },
  { label: "MongoDB", regex: /\bmongodb\b/i },
  { label: "Supabase", regex: /\bsupabase\b/i },
  { label: "Stripe", regex: /\bstripe\b/i },
  { label: "Shopify", regex: /\bshopify\b/i },
  { label: "Gemini", regex: /\bgemini\b/i },
  { label: "Claude", regex: /\bclaude\b/i },
  { label: "Cloudflare R2", regex: /\bcloudflare\s*r2\b/i },
  { label: "Vercel", regex: /\bvercel\b/i },
];

function extractTechnologies(posts: RawPost[], extraSources: string[] = []) {
  const corpus = [
    ...posts.map((post) => `${post.headline ?? ""}\n${post.articleBody ?? ""}\n${post.description ?? ""}`),
    ...extraSources,
  ].join("\n");

  const found = TECHNOLOGY_PATTERNS.filter((item) => item.regex.test(corpus)).map((item) => item.label);
  const projectTags = projects.flatMap((project) => project.tags);
  const normalizedCorpus = corpus.toLowerCase();
  const matchedProjectTags = projectTags
    .filter((tag) => normalizedCorpus.includes(tag.toLowerCase()))
    .filter((tag) => !/^llama$/i.test(tag))
    .filter((tag) => !/^fireworks(\s*ai|\.js)?$/i.test(tag));

  return uniqueCaseInsensitive([...found, ...matchedProjectTags]).slice(0, 16);
}

function extractNarrative(
  posts: RawPost[],
  achievements: string[],
  technologies: string[],
  collaborators: string[],
  sectionSources: string[] = [],
) {
  const postNarrative = posts
    .map((post) => clip(post.headline ?? splitSentences(post.articleBody ?? post.description)[0], 200))
    .filter((line): line is string => Boolean(line));

  const sectionNarrative = sectionSources
    .map((source) => clip(splitSentences(source)[0], 200))
    .filter((line): line is string => Boolean(line));

  const inferred = [
    achievements[0] ? `Recent result: ${achievements[0]}` : "",
    technologies.length > 0 ? `Frequent stack: ${technologies.slice(0, 8).join(", ")}.` : "",
    collaborators.length > 0
      ? `Frequent collaborators: ${collaborators.slice(0, 5).join(", ")}.`
      : "",
  ].filter(Boolean);

  return uniqueCaseInsensitive([...sectionNarrative, ...postNarrative, ...inferred]).slice(0, 8);
}

function buildSummary(
  baseSummary: string | undefined,
  achievements: string[],
  technologies: string[],
  collaborators: string[],
) {
  const conciseAchievementRaw = achievements[0]
    ? clip(
        achievements[0]
          .replace(/\([^)]*\)/g, "")
          .replace(/\bwe\b/gi, "")
          .replace(/\s+/g, " ")
          .trim(),
        140,
      )
    : "";
  const conciseAchievement = conciseAchievementRaw
    ? `Recent: ${conciseAchievementRaw.charAt(0).toUpperCase()}${conciseAchievementRaw.slice(1)}`
    : "";

  const parts = [baseSummary ?? "", conciseAchievement ?? ""].filter(Boolean);

  return clip(parts.join(" "), 260) ?? profile.bio;
}

async function main() {
  const storageStatePath = process.env.LINKEDIN_STORAGE_STATE_PATH?.trim();
  const hasCookieAuth =
    Boolean(process.env.LINKEDIN_COOKIE_LI_AT?.trim()) ||
    Boolean(process.env.LINKEDIN_COOKIE_JSESSIONID?.trim());
  const hasAuthInput = Boolean(storageStatePath) || hasCookieAuth;
  const manualLogin = envFlag("LINKEDIN_MANUAL_LOGIN", false);
  const headless = !manualLogin && !envFlag("LINKEDIN_HEADFUL", false);
  const userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

  const browser = await chromium.launch({ headless });
  const activeContext = await browser.newContext({
    userAgent,
    ...((hasAuthInput || manualLogin) && storageStatePath ? { storageState: storageStatePath } : {}),
  });

  if (storageStatePath && (hasAuthInput || manualLogin)) {
    console.log(`loaded LinkedIn storage state from ${storageStatePath}`);
  }
  if (hasCookieAuth && !storageStatePath) {
    await applyLinkedInAuthCookies(activeContext);
  } else if (hasCookieAuth && storageStatePath) {
    console.log("storage state is set; skipping explicit cookie injection");
  }

  const page = await activeContext.newPage();

  if (manualLogin) {
    await page.goto("https://www.linkedin.com/login", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await waitForEnter(
      "Manual LinkedIn login mode: complete login/challenge in the opened browser, then press Enter here.",
    );
  }

  const readMeta = async (url: string) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    return page.evaluate(() => {
      const getMeta = (key: "property" | "name", value: string) =>
        document.querySelector(`meta[${key}="${value}"]`)?.getAttribute("content") ?? undefined;

      const jsonLd = Array.from(
        document.querySelectorAll('script[type="application/ld+json"]'),
      ).flatMap((node) => {
        try {
          const raw = node.textContent ?? "";
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) return parsed as unknown[];
          return [parsed];
        } catch {
          return [];
        }
      });

      return {
        title: getMeta("property", "og:title"),
        description: getMeta("property", "og:description"),
        image: getMeta("property", "og:image"),
        jsonLd,
      };
    });
  };

  const profileScrapePage = page;
  let profileDetails = await readProfileDetails(profileScrapePage, profile.links.linkedin).catch(() => null);
  if (profileDetails?.authWall) {
    console.warn(
      "linkedin profile loaded behind authwall; set LINKEDIN_COOKIE_LI_AT for full profile sections",
    );
  }
  let safeProfileDetails =
    profileDetails && !profileDetails.authWall
      ? profileDetails
      : {
          name: undefined,
          headline: undefined,
          location: undefined,
          about: undefined,
          sections: [] as ProfileSection[],
          authWall: true,
        };
  let detailSections = await readDetailSections(profileScrapePage, profile.links.linkedin).catch(
    () => [],
  );
  let profileSections = mergeSections(detailSections, safeProfileDetails.sections ?? []);

  // If storage state looks stale but cookies exist, retry with cookies-only context.
  if (profileSections.length === 0 && storageStatePath && hasCookieAuth && !manualLogin) {
    try {
      const cookieContext = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      });
      await applyLinkedInAuthCookies(cookieContext);
      const cookiePage = await cookieContext.newPage();
      const cookieProfileDetails = await readProfileDetails(cookiePage, profile.links.linkedin).catch(() => null);
      const cookieSafeProfileDetails =
        cookieProfileDetails && !cookieProfileDetails.authWall
          ? cookieProfileDetails
          : {
              name: undefined,
              headline: undefined,
              location: undefined,
              about: undefined,
              sections: [] as ProfileSection[],
              authWall: true,
            };
      const cookieDetailSections = await readDetailSections(cookiePage, profile.links.linkedin).catch(
        () => [],
      );
      const cookieMergedSections = mergeSections(
        cookieDetailSections,
        cookieSafeProfileDetails.sections ?? [],
      );

      if (cookieMergedSections.length > 0) {
        console.log("using cookie-based profile sections fallback");
        safeProfileDetails = cookieSafeProfileDetails;
        detailSections = cookieDetailSections;
        profileSections = cookieMergedSections;
      }

      await cookieContext.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`cookie fallback for profile sections failed: ${message}`);
    }
  }

  const profileMeta = await readMeta(profile.links.linkedin).catch(() => null);
  const profilePerson = profileMeta?.jsonLd.find((entry) => {
    return (
      entry &&
      typeof entry === "object" &&
      (entry as { "@type"?: string })["@type"] === "Person"
    );
  }) as
    | {
        name?: string;
        url?: string;
        description?: string;
        jobTitle?: string;
        image?: { url?: string } | string;
        interactionStatistic?: { userInteractionCount?: number };
      }
    | undefined;

  const postUrls = [...new Set(projects.map((project) => project.linkedinUrl).filter(Boolean))] as string[];
  const rawPosts: RawPost[] = [];

  for (const url of postUrls) {
    try {
      const postMeta = await readMeta(url);
      const socialPost = postMeta.jsonLd.find((entry) => {
        return (
          entry &&
          typeof entry === "object" &&
          (entry as { "@type"?: string })["@type"] === "SocialMediaPosting"
        );
      }) as
        | {
            headline?: string;
            articleBody?: string;
            datePublished?: string;
            commentCount?: number;
            image?: { url?: string } | string;
            video?: { embedUrl?: string; thumbnailUrl?: string };
            author?: {
              name?: string;
              url?: string;
              image?: { url?: string } | string;
              interactionStatistic?: { userInteractionCount?: number };
            };
          }
        | undefined;

      rawPosts.push({
        url,
        title: postMeta.title,
        description: postMeta.description,
        image: postMeta.image,
        headline: socialPost?.headline,
        articleBody: socialPost?.articleBody,
        publishedAt: socialPost?.datePublished,
        commentCount: socialPost?.commentCount,
        videoUrl: socialPost?.video?.embedUrl,
        thumbnailUrl: socialPost?.video?.thumbnailUrl,
        authorName: socialPost?.author?.name,
        authorUrl: socialPost?.author?.url,
        authorImage:
          typeof socialPost?.author?.image === "string"
            ? socialPost.author.image
            : socialPost?.author?.image?.url,
        followerCount: socialPost?.author?.interactionStatistic?.userInteractionCount,
      });
      console.log(`scraped ${url}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`failed ${url}: ${message}`);
    }
  }

  const firstAuthor = rawPosts.find((post) => post.authorName || post.authorImage || post.authorUrl);
  const sectionSources = profileSections.flatMap((section) => section.items);
  const achievements = extractAchievements(rawPosts, sectionSources);
  const technologies = extractTechnologies(rawPosts, sectionSources);
  const collaborators = extractCollaborators(rawPosts, sectionSources);
  const narrative = extractNarrative(rawPosts, achievements, technologies, collaborators, sectionSources);

  const aboutSection = profileSections.find((section) => /^about$/i.test(section.title));
  const summary = buildSummary(
    safeProfileDetails.about ??
      aboutSection?.items[0] ??
      profileMeta?.description ??
      profilePerson?.description ??
      profile.bio,
    achievements,
    technologies,
    collaborators,
  );

  const outputDir = path.join(process.cwd(), "src", "data");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "linkedin-about.json");
  const existingSnapshot = await readExistingSnapshot(outputPath);

  const sectionsForSnapshot =
    profileSections.length > 0
      ? profileSections
      : hasSections(existingSnapshot?.sections)
        ? existingSnapshot?.sections
        : [];

  const snapshot: LinkedInSnapshot = {
    profile: {
      name: safeProfileDetails.name ?? firstAuthor?.authorName ?? profilePerson?.name ?? profile.name,
      title:
        safeProfileDetails.headline ??
        cleanTitle(profileMeta?.title) ??
        profilePerson?.jobTitle ??
        profile.role,
      summary,
      imageUrl:
        (typeof profilePerson?.image === "string" ? profilePerson.image : profilePerson?.image?.url) ??
        firstAuthor?.authorImage ??
        existingSnapshot?.profile.imageUrl,
      location: safeProfileDetails.location ?? profile.location,
      linkedinUrl: profilePerson?.url ?? firstAuthor?.authorUrl ?? profile.links.linkedin,
      followerCount: firstAuthor?.followerCount ?? profilePerson?.interactionStatistic?.userInteractionCount,
      achievements,
      technologies,
      collaborators,
      narrative,
    },
    sections: sectionsForSnapshot,
    posts: rawPosts
      .map((post) => ({
        url: post.url,
        headline: post.headline ?? cleanTitle(post.title),
        body: post.articleBody ?? post.description,
        excerpt: clip(post.articleBody ?? post.description),
        publishedAt: post.publishedAt,
        imageUrl: post.thumbnailUrl ?? post.image,
        videoUrl: post.videoUrl,
        commentCount: post.commentCount,
      }))
      .sort((a, b) => {
        const aTime = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
        const bTime = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
        return bTime - aTime;
      }),
    pulledAt: new Date().toISOString(),
    source: "playwright",
  };

  const cleanedSnapshot = await cleanSnapshotWithOpenRouter(snapshot);
  await writeFile(outputPath, JSON.stringify(cleanedSnapshot, null, 2));

  await browser.close();
  console.log(`wrote ${outputPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
