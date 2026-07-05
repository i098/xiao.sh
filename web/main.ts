// Browser entry for the DOM-rendered app: the same tui/app.tsx tree, rendered by react-dom
// with local input handling (zero-RTT) — the server only serves data over /api/*.
// Deliberately JSX-free: this file typechecks in the tui tsconfig program (where JSX means
// opentui elements), so the App import stays type-safe without a JSX-type collision.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import App from "../tui/app";
import { initMetrics } from "./dom/metrics";
import { startPond } from "./dom/pond";
import { createVolumeChannel } from "./dom/volume";

async function boot(): Promise<void> {
  const appEl = document.getElementById("app");
  const rootEl = document.getElementById("root");
  if (!appEl || !rootEl) return;
  initMetrics(rootEl);
  startPond(appEl); // koi visible immediately, behind the boot screen's transparent rows
  const distinctId = crypto.randomUUID();
  try {
    const r = await fetch("/api/boot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ distinctId }),
    });
    if (!r.ok) throw new Error(String(r.status));
    const { linkedIn, visit } = await r.json();
    createRoot(rootEl).render(
      createElement(App, {
        linkedIn,
        visit,
        distinctId,
        // ponytail: no connection to close on the web — `q` lands on the goodbye screen; reload restarts
        onExit: () => {},
        volume: createVolumeChannel(),
        pond: false, // the canvas pond above replaces the cell-buffer KoiPond
      }),
    );
  } catch {
    rootEl.textContent = "connection failed — reload to retry";
  }
}

void boot();
