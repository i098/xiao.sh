// Browser twin of @/lib/presence: a 2s heartbeat to /api/presence doubles as the read —
// the response carries the fleet-wide live count (ssh joins + web beats).
let live = 1;
let started = false;

function start(): void {
  if (started) return;
  started = true;
  const id = crypto.randomUUID();
  const tick = () => {
    fetch("/api/presence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    })
      .then((r) => r.json())
      .then((d: { live?: number }) => {
        if (typeof d.live === "number") live = d.live;
      })
      .catch(() => {});
  };
  tick();
  setInterval(tick, 2000);
}

export function liveCount(): number {
  start();
  return live;
}

// session join/leave is implicit in the heartbeat TTL
export function join(): void {}
export function leave(): void {}
