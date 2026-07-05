// Browser twin of @/lib/analytics: fire-and-forget through the server's posthog-node
// (no PostHog browser SDK — no new dependency, no client keys).
export function capture(distinctId: string, event: string, properties?: Record<string, unknown>): void {
  fetch("/api/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ distinctId, event, properties }),
  }).catch(() => {});
}
