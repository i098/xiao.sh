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

// Resolves once the event is sent, so a Worker can hand it to ctx.waitUntil (an un-awaited
// send is cancelled when the response ends). Never rejects.
export async function capture(distinctId: string, event: string, properties?: Record<string, unknown>): Promise<void> {
  const c = get();
  if (!c) return;
  try {
    await c.captureImmediate({ distinctId, event, properties });
  } catch {
    // analytics must never break the app
  }
}
