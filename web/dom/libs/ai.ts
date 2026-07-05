// Browser twin of @/lib/ai: POST /api/chat proxies OpenRouter server-side (rate-limited).
import type { AskResult, ChatMessage } from "../../../src/lib/ai";
export type { AskResult, ChatMessage };

export async function ask(messages: ChatMessage[]): Promise<AskResult> {
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    return (await r.json()) as AskResult;
  } catch {
    return { error: "network error — try again" };
  }
}
