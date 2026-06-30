import { PostHog } from "posthog-node";

// Server-side PostHog capture for the TUI. No-op unless POSTHOG_API_KEY is set, and it must
// never throw into the render path — analytics failures are swallowed.
let client: PostHog | null = null;
let resolved = false;

function get(): PostHog | null {
  if (resolved) return client;
  resolved = true;
  const key = process.env.POSTHOG_API_KEY?.trim();
  if (!key) return (client = null);
  const host = process.env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com";
  client = new PostHog(key, { host, flushAt: 1, flushInterval: 0 });
  return client;
}

export function capture(distinctId: string, event: string, properties?: Record<string, unknown>): void {
  const c = get();
  if (!c) return;
  try {
    c.capture({ distinctId, event, properties });
  } catch {
    // analytics must never break the app
  }
}

export async function shutdownAnalytics(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown();
  } catch {
    // ignore
  }
}
