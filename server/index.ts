// Run both entry points: browser web terminal + ssh. Each module starts on import.
import "./web";
import "./ssh";

// Refresh the LinkedIn snapshot every minute (best-effort).
// Needs Playwright + LinkedIn auth (LINKEDIN_COOKIE_LI_AT / LINKEDIN_STORAGE_STATE_PATH);
// without them it falls back to public/limited data. Runs are skipped if one is in flight.
// Skipped entirely when playwright isn't installed (production image prunes devDeps) —
// otherwise the spawn crash-loops every 60s and spams the pod log.
let syncing = false;
function syncLinkedIn() {
  if (syncing) return;
  syncing = true;
  const proc = Bun.spawn(["bun", "run", "scripts/sync-linkedin-about.ts"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  proc.exited.then(() => (syncing = false)).catch(() => (syncing = false));
}
try {
  Bun.resolveSync("playwright", import.meta.dir);
  syncLinkedIn();
  setInterval(syncLinkedIn, 60_000);
} catch {
  console.warn("linkedin sync disabled: playwright not installed (serving the baked-in snapshot)");
}
