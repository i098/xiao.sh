// Lean port of the old /api/ai-search route for the TUI.
// Keeps: free-model discovery + rotation, profile-context Q&A, age shortcut, retry loop.
// Dropped: the email-compose tool (mailto can't open in a terminal). Re-add if wanted.
import { getLinkedInSnapshot } from "@/lib/linkedin";
import { profile } from "@/lib/profile";
import { getProjects } from "@/lib/projects";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_REFRESH_MS = 15 * 60 * 1000;
const DEFAULT_MODEL_POOL_SIZE = 8;
const DEFAULT_FALLBACK_MODELS = ["openrouter/free"];
const MAX_CONVERSATION_MESSAGES = 50;
const MAX_OPENROUTER_FALLBACK_MODELS = 3;
const MAX_REQUEST_ATTEMPTS = 4;
const RETRY_BACKOFF_MS = 350;
const ASK_RATE_WINDOW_MS = 60_000;
const MAX_ASKS_PER_WINDOW = 30;
const MAX_CONCURRENT_ASKS = 8;

export type ChatMessage = { role: "user" | "assistant"; content: string };
export type AskResult = { answer?: string; error?: string; model?: string };

type OpenRouterMessage = { role: "system" | "user" | "assistant"; content: string };
type OpenRouterResponse = {
  choices?: { message?: { content?: string } }[];
  model?: string;
  error?: { code?: number; message?: string; metadata?: Record<string, unknown> };
};
type OpenRouterModel = {
  id?: string;
  name?: string;
  created?: number;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string; request?: string };
};

let modelPoolCache: { models: string[]; expiresAt: number } | null = null;
let rotationCursor = 0;
let activeAsks = 0;
const askTimes: number[] = [];

function globalAskAllowed(now: number) {
  while (askTimes.length && now - askTimes[0] > ASK_RATE_WINDOW_MS) askTimes.shift();
  if (askTimes.length >= MAX_ASKS_PER_WINDOW || activeAsks >= MAX_CONCURRENT_ASKS) return false;
  askTimes.push(now);
  return true;
}

function headers(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "https://xiao.sh",
    "X-Title": process.env.OPENROUTER_SITE_NAME ?? "xiao.sh",
  };
}

function parseDob(value: string | undefined) {
  if (!value?.trim()) return null;
  const us = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const d = new Date(Date.UTC(+us[3], +us[1] - 1, +us[2]));
    if (!Number.isNaN(d.getTime())) return d;
  }
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function computeAge(dob: Date, asOf: Date) {
  let age = asOf.getUTCFullYear() - dob.getUTCFullYear();
  const m = asOf.getUTCMonth() - dob.getUTCMonth();
  const d = asOf.getUTCDate() - dob.getUTCDate();
  if (m < 0 || (m === 0 && d < 0)) age -= 1;
  return age;
}

function buildAgeAnswer(userMessage: string): string | null {
  if (!/\b(age|how old|old is)\b/i.test(userMessage)) return null;
  const dob = parseDob(profile.dob);
  if (!dob) return "Age is not listed on this site.";
  const asOf = new Date();
  return `${profile.name} is ${computeAge(dob, asOf)} years old (DOB: ${profile.dob}).`;
}

async function buildProfileContext() {
  const linkedIn = await getLinkedInSnapshot().catch(() => null);
  const projectLines = (await getProjects())
    .map((p) => {
      const links = [
        `GitHub: ${p.githubUrl}`,
        p.linkedinUrl ? `LinkedIn: ${p.linkedinUrl}` : "",
        p.eventUrl ? `Event: ${p.eventUrl}` : "",
      ]
        .filter(Boolean)
        .join(" | ");
      const award = p.award ? `Award: ${p.award.place}, ${p.award.event} (${p.award.when})\n  ` : "";
      return `- ${p.title} (${p.year}, ${p.category}, ${p.role}, ${p.status}): ${p.summary}\n  Stack: ${p.stack.join(", ")}\n  ${award}${links}`;
    })
    .join("\n");

  const dob = parseDob(profile.dob);
  const age = dob ? computeAge(dob, new Date()) : null;

  const linkedInLines = linkedIn
    ? [
        linkedIn.profile.title ? `Title: ${linkedIn.profile.title}` : "",
        linkedIn.profile.summary ? `Summary: ${linkedIn.profile.summary}` : "",
        typeof linkedIn.profile.followerCount === "number" ? `Followers: ${linkedIn.profile.followerCount}` : "",
        linkedIn.profile.technologies?.length ? `Technologies: ${linkedIn.profile.technologies.join(", ")}` : "",
        ...(linkedIn.sections ?? []).map((s) => `${s.title}: ${s.items.slice(0, 8).join(" | ")}`),
        "",
        "Recent posts:",
        ...linkedIn.posts.slice(0, 6).map((post) => `- ${post.headline ?? "Post"} (${post.url})`),
      ].filter(Boolean)
    : ["Unavailable"];

  return [
    `You are a portfolio assistant for ${profile.name}.`,
    "Only answer using the profile, project, and LinkedIn context below.",
    "If something is unknown, say it is not listed on this site. Keep answers concise and factual.",
    "Answer in plain text only — no markdown, no ** or # formatting; this renders in a terminal.",
    "",
    "Profile:",
    `Name: ${profile.name}`,
    `Role: ${profile.role}`,
    `Date of Birth: ${profile.dob?.trim() ? profile.dob : "Not listed"}`,
    age !== null ? `Age: ${age}` : "Age: Not listed",
    `Location: ${profile.location}`,
    `Education: ${profile.education}`,
    `Skills: ${profile.skills.join(", ")}`,
    `GitHub: ${profile.links.github}`,
    `LinkedIn: ${profile.links.linkedin}`,
    `Email: ${profile.links.email}`,
    "",
    "LinkedIn:",
    ...linkedInLines,
    "",
    "Projects:",
    projectLines,
  ].join("\n");
}

function toNumber(v: string | number | undefined) {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return Number.NaN;
  return Number.parseFloat(v);
}

function isFreeModel(model: OpenRouterModel) {
  const p = toNumber(model.pricing?.prompt);
  const c = toNumber(model.pricing?.completion);
  const r = toNumber(model.pricing?.request);
  const zero =
    (Number.isNaN(p) || p === 0) && (Number.isNaN(c) || c === 0) && (Number.isNaN(r) || r === 0);
  return zero || model.id?.endsWith(":free") === true;
}

function supportsText(model: OpenRouterModel) {
  const i = model.architecture?.input_modalities;
  const o = model.architecture?.output_modalities;
  if (!i && !o) return true;
  return (!i || i.includes("text")) && (!o || o.includes("text"));
}

function sotaScore(model: OpenRouterModel) {
  const id = `${model.id ?? ""} ${model.name ?? ""}`.toLowerCase();
  let s = 0;
  if (id.includes("gpt-oss")) s += 30;
  if (id.includes("qwen3")) s += 24;
  if (id.includes("llama-4")) s += 22;
  if (id.includes("kimi-k2")) s += 22;
  if (id.includes("deepseek-r1") || id.includes("deepseek-v3")) s += 20;
  if (id.includes("gemini-2.5")) s += 18;
  if (id.includes(":free")) s += 4;
  // reasoning models burn the token budget on <think> and leak it into the answer —
  // keep them at the back of the pool
  if (/\br1\b|r1-|reason|think/i.test(id)) s -= 25;
  s += Math.min(12, Math.log2(Math.max(1, (model.context_length ?? 0) / 8192 + 1)) * 4);
  s += Math.min(8, (model.created ?? 0) / 1_000_000_000);
  return s;
}

// Reasoning models sometimes inline their scratchpad into content. Drop paired
// <think> blocks, a truncated trailing block, and an orphaned leading close tag.
function cleanAnswer(raw: string): string {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const open = s.search(/<think>/i);
  if (open !== -1) s = s.slice(0, open);
  const close = s.search(/<\/think>/i);
  if (close !== -1) s = s.slice(close + "</think>".length);
  // models ignore the plain-text instruction half the time — drop markdown bold markers
  s = s.replace(/\*\*(.+?)\*\*/g, "$1");
  return s.trim();
}

async function fetchFreeModels(apiKey: string) {
  const res = await fetch(OPENROUTER_MODELS_URL, { headers: headers(apiKey), cache: "no-store" });
  if (!res.ok) throw new Error(`models ${res.status}`);
  const data = (await res.json()) as { data?: OpenRouterModel[] };
  const size = Number.parseInt(process.env.OPENROUTER_MODEL_POOL_SIZE ?? "", 10) || DEFAULT_MODEL_POOL_SIZE;
  return (data.data ?? [])
    .filter((m) => Boolean(m.id))
    .filter(isFreeModel)
    .filter(supportsText)
    .sort((a, b) => sotaScore(b) - sotaScore(a))
    .slice(0, size)
    .map((m) => m.id as string);
}

function rotate(models: string[]) {
  if (models.length <= 1) return models;
  const start = rotationCursor % models.length;
  rotationCursor = (rotationCursor + 1) % models.length;
  return [...models.slice(start), ...models.slice(0, start)];
}

async function getModelOrder(apiKey: string) {
  const now = Date.now();
  if (modelPoolCache && modelPoolCache.expiresAt > now && modelPoolCache.models.length) {
    return rotate(modelPoolCache.models);
  }
  const envModels = (process.env.OPENROUTER_MODELS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  let discovered: string[] = [];
  if (process.env.OPENROUTER_DYNAMIC_MODELS !== "false") {
    discovered = await fetchFreeModels(apiKey).catch(() => []);
  }
  const models = [...new Set([...envModels, ...discovered, ...DEFAULT_FALLBACK_MODELS])].filter(Boolean);
  modelPoolCache = { models, expiresAt: now + DEFAULT_REFRESH_MS };
  return rotate(models);
}

function isRetriable(status: number) {
  // 500 included: free-pool models throw transient Internal Server Errors — rotate, don't die
  return [429, 500, 502, 503, 504, 529].includes(status);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function prepareConversation(messages: ChatMessage[]): { conversation: ChatMessage[] } | AskResult {
  const conversation = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.trim() }))
    .slice(-MAX_CONVERSATION_MESSAGES);

  if (!conversation.length) return { error: "Missing query." };
  if (conversation[conversation.length - 1].role !== "user") {
    return { error: "Last message must be from the user." };
  }
  return { conversation };
}

export async function ask(messages: ChatMessage[]): Promise<AskResult> {
  const prepared = prepareConversation(messages);
  if (!("conversation" in prepared)) return prepared;
  const { conversation } = prepared;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { error: "OPENROUTER_API_KEY is not configured." };

  const latest = conversation[conversation.length - 1].content;
  const ageAnswer = buildAgeAnswer(latest);
  if (ageAnswer) return { answer: ageAnswer, model: "local/profile-facts" };

  if (!globalAskAllowed(Date.now())) return { error: "Chat is busy right now. Try again in a minute." };

  activeAsks += 1;
  try {
    const context = await buildProfileContext();
    const payload: OpenRouterMessage[] = [{ role: "system", content: context }, ...conversation];

    let lastError = "OpenRouter request failed.";
    const initialOrder = await getModelOrder(apiKey);

    for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
      const order = attempt === 0 ? initialOrder : await getModelOrder(apiKey);
      const [primary, ...rest] = order;
      try {
        const res = await fetch(OPENROUTER_URL, {
          method: "POST",
          headers: headers(apiKey),
          body: JSON.stringify({
            model: primary ?? "openrouter/free",
            models: rest.slice(0, MAX_OPENROUTER_FALLBACK_MODELS),
            provider: { allow_fallbacks: true },
            temperature: 0.2,
            // no max_tokens: let the model run to its natural stop — the system prompt
            // already asks for concise answers. exclude keeps reasoning out of content.
            reasoning: { exclude: true },
            stream: false,
            messages: payload,
          }),
        });
        const data = (await res.json()) as OpenRouterResponse;
        if (res.ok && !data.error) {
          const answer = cleanAnswer(data.choices?.[0]?.message?.content ?? "");
          if (answer) return { answer, model: data.model ?? primary };
          lastError = "OpenRouter returned empty content.";
        } else {
          const status = typeof data.error?.code === "number" ? data.error.code : res.status || 502;
          lastError = data.error?.message ?? lastError;
          if (!isRetriable(status)) break;
        }
      } catch (error) {
        lastError = `OpenRouter request failed: ${error instanceof Error ? error.message : "unknown"}`;
      }
      if (attempt < MAX_REQUEST_ATTEMPTS - 1) await delay(RETRY_BACKOFF_MS * (attempt + 1));
    }

    // all attempts exhausted — visitors get something human, not an upstream status line
    return { error: `Chat is busy right now (${lastError}). Try again in a moment.` };
  } finally {
    activeAsks -= 1;
  }
}
