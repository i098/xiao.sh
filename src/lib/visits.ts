import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "visits.json");
const WINDOW = 14; // sparkline days

type Store = { total: number; days: Record<string, number> };

export type VisitInfo = { count: number; daily: number[] };

function read(): Store {
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as Partial<Store>;
    return { total: parsed.total ?? 0, days: parsed.days ?? {} };
  } catch {
    return { total: 0, days: {} };
  }
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function lastDays(store: Store, n: number): number[] {
  const out: number[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    out.push(store.days[dayKey(d)] ?? 0);
  }
  return out;
}

// Increment the persisted visit counter and return the running total + a daily window
// for the home-screen sparkline.
// ponytail: plain read-modify-write — fine for portfolio traffic; add a lock file if it ever races.
export function recordVisit(): VisitInfo {
  const store = read();
  store.total += 1;
  const k = dayKey(new Date());
  store.days[k] = (store.days[k] ?? 0) + 1;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(store));
  } catch {
    // best-effort persistence; never block a session on the counter
  }
  return { count: store.total, daily: lastDays(store, WINDOW) };
}

if (import.meta.main) {
  const a = recordVisit();
  const b = recordVisit();
  if (b.count !== a.count + 1) throw new Error("counter did not increment");
  if (a.daily.length !== WINDOW) throw new Error("sparkline window wrong length");
  console.log("visits ok", b.count, b.daily);
}
