// Browser twin of @/lib/questions: a no-op — /api/chat records the question server-side,
// so the TUI's own recordQuestion call must not double-log.
export function recordQuestion(_text: string): void {}
