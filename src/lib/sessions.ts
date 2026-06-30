import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChatMessage } from "@/lib/ai";

// Saved chat transcripts, stored server-side keyed by a sanitized slug.
// ponytail: global namespace, no auth — anyone can /resume any saved name. Fine for a personal
// site; gate by a per-session token if that ever matters.
const DIR = path.join(process.cwd(), ".data", "sessions");

export type SavedSession = { name: string; slug: string; count: number; savedAt: string };

// slugify also neutralizes path traversal (strips slashes/dots) — keep it on every fs access.
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
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path.join(DIR, `${slug}.json`), JSON.stringify({ name, slug, savedAt, messages }));
  } catch {
    // best-effort
  }
  return { name, slug, count: messages.length, savedAt };
}

export function listSessions(): SavedSession[] {
  try {
    return readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f): SavedSession | null => {
        try {
          const data = JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as {
            name?: string;
            slug?: string;
            savedAt?: string;
            messages?: unknown[];
          };
          return {
            name: data.name ?? f.replace(/\.json$/, ""),
            slug: data.slug ?? f.replace(/\.json$/, ""),
            count: Array.isArray(data.messages) ? data.messages.length : 0,
            savedAt: data.savedAt ?? "",
          };
        } catch {
          return null;
        }
      })
      .filter((x): x is SavedSession => Boolean(x))
      .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  } catch {
    return [];
  }
}

export function deleteSession(slugOrName: string): boolean {
  const slug = slugify(slugOrName);
  try {
    unlinkSync(path.join(DIR, `${slug}.json`));
    return true;
  } catch {
    return false;
  }
}

export function loadSession(slugOrName: string): ChatMessage[] | null {
  const slug = slugify(slugOrName);
  try {
    const data = JSON.parse(readFileSync(path.join(DIR, `${slug}.json`), "utf8")) as { messages?: ChatMessage[] };
    return Array.isArray(data.messages) ? data.messages : null;
  } catch {
    return null;
  }
}
