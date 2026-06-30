import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Aggregate chat questions (counts only) so the home screen can show "what people ask".
// Stores the verbatim prompt keyed by a normalized form. ponytail: no PII scrubbing beyond a
// length cap — fine for a portfolio Q&A bot; add redaction if the corpus ever gets sensitive.
const FILE = path.join(process.cwd(), ".data", "questions.json");

type Entry = { text: string; count: number };
type Store = { items: Record<string, Entry> };

function read(): Store {
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as Partial<Store>;
    return { items: parsed.items ?? {} };
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
    .slice(0, 80);
}

export function recordQuestion(text: string): void {
  const t = text.trim();
  if (!t || t.startsWith("/")) return;
  const key = normalize(t);
  if (!key) return;
  const store = read();
  store.items[key] = { text: t.slice(0, 80), count: (store.items[key]?.count ?? 0) + 1 };
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(store));
  } catch {
    // best-effort
  }
}

export function topQuestions(n: number): Entry[] {
  return Object.values(read().items)
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}
