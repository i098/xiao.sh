// Run both entry points: browser web terminal + ssh. Each module starts on import.
import "./web";
import "./ssh";

// Refresh the LinkedIn snapshot every minute (best-effort).
// Needs Playwright + LinkedIn auth (LINKEDIN_COOKIE_LI_AT / LINKEDIN_STORAGE_STATE_PATH);
// without them it falls back to public/limited data. Runs are skipped if one is in flight.
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
syncLinkedIn();
setInterval(syncLinkedIn, 60_000);
