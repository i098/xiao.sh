import { get, put } from "@/lib/store";

const KEY = "visits.json";
const WINDOW = 14; // sparkline days

type Store = { total: number; days: Record<string, number> };

export type VisitInfo = { count: number; daily: number[] };

async function read(): Promise<Store> {
  const parsed = JSON.parse((await get(KEY)) ?? "{}") as Partial<Store>;
  return { total: parsed.total ?? 0, days: parsed.days ?? {} };
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
// ponytail: plain read-modify-write — fine for portfolio traffic; concurrent visits (or KV's
// eventual consistency across Cloudflare locations) can drop an increment.
export async function recordVisit(): Promise<VisitInfo> {
  let store: Store;
  try {
    store = await read();
  } catch {
    return { count: 0, daily: lastDays({ total: 0, days: {} }, WINDOW) };
  }
  store.total += 1;
  const k = dayKey(new Date());
  store.days[k] = (store.days[k] ?? 0) + 1;
  try {
    await put(KEY, JSON.stringify(store));
  } catch {
    // best-effort persistence; never block a session on the counter
  }
  return { count: store.total, daily: lastDays(store, WINDOW) };
}

if (import.meta.main) {
  const a = await recordVisit();
  const b = await recordVisit();
  if (b.count !== a.count + 1) throw new Error("counter did not increment");
  if (a.daily.length !== WINDOW) throw new Error("sparkline window wrong length");
  console.log("visits ok", b.count, b.daily);
}
