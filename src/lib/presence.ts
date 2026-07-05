// Live concurrent-session counter. All ssh + web sessions run in one server process,
// so a module-level integer is the whole implementation.
// ponytail: in-process only — if the TUI is ever run multi-process, back this with shared state.
let count = 0;

// Web (DOM) sessions have no long-lived connection to join/leave on, so they
// heartbeat instead: a beat marks the id live for BEAT_TTL_MS.
const BEAT_TTL_MS = 10_000;
const beats = new Map<string, number>();

export function join(): void {
  count += 1;
}
export function leave(): void {
  count = Math.max(0, count - 1);
}
export function beat(id: string): void {
  const now = Date.now();
  beats.set(id, now);
  // prune on write; the map only holds currently-open tabs
  for (const [k, t] of beats) if (now - t > BEAT_TTL_MS) beats.delete(k);
}
export function liveCount(): number {
  const now = Date.now();
  let web = 0;
  for (const t of beats.values()) if (now - t <= BEAT_TTL_MS) web += 1;
  return count + web;
}
