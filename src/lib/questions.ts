import { get, put } from "@/lib/store";

// Aggregate chat questions so the home screen can show "what people ask".
// This is visitor input shown publicly, so it is filtered on two axes:
//  1. PII / contact info is never stored (emails, phones, URLs, @handles, long digit runs).
//  2. Only questions asked by (likely) more than one person are ever displayed (MIN_SHOW),
//     so a one-off message can't surface on the home page.
// Stored via @/lib/store (.data locally, KV on Cloudflare), counts + a length-capped verbatim copy of the prompt.
const KEY = "questions.json";
const MAX_LEN = 80;
const MIN_LEN = 6;

// looks-like-contact-info — if any matches, the question is dropped entirely (not stored)
const PII = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/, // email
  /https?:\/\/\S+/i, // url
  /(^|\s)@\w{2,}/, // @handle
  /\+?\d[\d().\-\s]{6,}\d/, // phone / long digit run
];

type Entry = { text: string; count: number };
type Store = { items: Record<string, Entry>; last?: string };

async function read(): Promise<Store> {
  try {
    const parsed = JSON.parse((await get(KEY)) ?? "{}") as Partial<Store>;
    return { items: parsed.items ?? {}, last: parsed.last };
  } catch {
    return { items: {} };
  }
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim()
    .slice(0, MAX_LEN);
}

export async function recordQuestion(text: string): Promise<void> {
  const t = text.trim();
  if (!t || t.startsWith("/")) return;
  if (t.length < MIN_LEN) return; // too short to be a real question
  if (PII.some((re) => re.test(t))) return; // never store contact info
  const key = normalize(t);
  if (!key) return;
  const store = await read();
  const clipped = t.slice(0, MAX_LEN);
  store.items[key] = { text: clipped, count: (store.items[key]?.count ?? 0) + 1 };
  store.last = clipped; // most-recent question (already PII-filtered above)
  try {
    await put(KEY, JSON.stringify(store));
  } catch {
    // best-effort
  }
}
