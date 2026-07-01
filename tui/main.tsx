import { randomUUID } from "node:crypto";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { getLinkedInSnapshot } from "@/lib/linkedin";
import { recordVisit } from "@/lib/visits";
import { capture } from "@/lib/analytics";
import App from "./app";

// Standalone: run the TUI directly in the current terminal (`bun tui/main.tsx`).
const linkedIn = await getLinkedInSnapshot();
const visit = recordVisit();
const distinctId = randomUUID();
capture(distinctId, "visit", { count: visit.count });
const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true, enableMouseMovement: true, targetFps: 60 });
createRoot(renderer).render(
  <App
    linkedIn={linkedIn}
    visit={visit}
    distinctId={distinctId}
    onExit={() => {
      renderer.destroy();
      process.exit(0);
    }}
  />,
);
