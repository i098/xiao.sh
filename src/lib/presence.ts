// Live concurrent-session counter. All ssh + web sessions run in one server process,
// so a module-level integer is the whole implementation.
// ponytail: in-process only — if the TUI is ever run multi-process, back this with shared state.
let count = 0;

export function join(): void {
  count += 1;
}
export function leave(): void {
  count = Math.max(0, count - 1);
}
export function liveCount(): number {
  return count;
}
