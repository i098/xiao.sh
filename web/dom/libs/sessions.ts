// Browser twin of @/lib/sessions: saved chats live in localStorage, private per browser.
// ponytail: deliberate semantic change from the server store (which is global across all
// visitors and still serves ssh) — a visitor's /save is theirs alone here.
// slugify/autoName are copied from src/lib/sessions.ts (it top-imports node:fs, can't share).
import type { ChatMessage } from "../../../src/lib/ai";
import type { SavedSession } from "../../../src/lib/sessions";
export type { SavedSession };

const KEY = "xiao-sessions";
type Stored = { name: string; slug: string; savedAt: string; messages: ChatMessage[] };

function readAll(): Stored[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as Stored[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeAll(all: Stored[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // best-effort (private mode / quota)
  }
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "session"
  );
}

export function autoName(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (firstUser && firstUser.content.trim()) return firstUser.content.trim().slice(0, 40);
  return `chat-${new Date().toISOString().slice(5, 16).replace(/[:T]/g, "-")}`;
}

export function saveSession(name: string, messages: ChatMessage[]): SavedSession {
  const slug = slugify(name);
  const savedAt = new Date().toISOString();
  const all = readAll().filter((s) => s.slug !== slug);
  all.push({ name, slug, savedAt, messages });
  writeAll(all);
  return { name, slug, count: messages.length, savedAt };
}

export function listSessions(): SavedSession[] {
  return readAll()
    .map((s) => ({ name: s.name, slug: s.slug, count: s.messages.length, savedAt: s.savedAt }))
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

export function deleteSession(slugOrName: string): boolean {
  const slug = slugify(slugOrName);
  const all = readAll();
  const next = all.filter((s) => s.slug !== slug);
  writeAll(next);
  return next.length < all.length;
}

export function loadSession(slugOrName: string): ChatMessage[] | null {
  const slug = slugify(slugOrName);
  const hit = readAll().find((s) => s.slug === slug);
  return hit && Array.isArray(hit.messages) ? hit.messages : null;
}
