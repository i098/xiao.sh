import { randomUUID } from "node:crypto";
import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { getLinkedInSnapshot } from "@/lib/linkedin";
import { recordVisit } from "@/lib/visits";
import { capture } from "@/lib/analytics";
import { join, leave } from "@/lib/presence";
import App from "./app";

export type SessionStreams = {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  width: number;
  height: number;
};

// Gate concurrent cold-mounts. A burst of sessions constructing their renderer + React
// tree at the same instant transiently spikes heap far past steady-state and OOM-kills the
// pod; draining them a few at a time keeps the peak bounded. ponytail: 8-at-a-time + 300ms
// settle is a calibration knob for the 2Gi pod — raise for faster drain under load, lower
// if heap still spikes. Steady-state (~660MiB at 48 sessions) is nowhere near the limit; the
// mount storm is the only danger.
const MAX_CONCURRENT_MOUNTS = 8;
const MOUNT_SETTLE_MS = 300;
let activeMounts = 0;
const mountWaiters: Array<() => void> = [];
function acquireMount(): Promise<void> {
  if (activeMounts < MAX_CONCURRENT_MOUNTS) {
    activeMounts += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => mountWaiters.push(resolve));
}
function releaseMount(): void {
  const next = mountWaiters.shift();
  if (next) next(); // hand the slot to a waiter; in-flight count stays at the cap
  else activeMounts -= 1;
}

// Render the app onto an arbitrary transport (ssh channel / ws-backed stream / real tty).
// `volume` (web sessions only) links the TUI volume bar to the browser tab's ambient audio.
// `pond: false` (web sessions) skips the server-drawn koi pond — the browser renders it
// locally on a canvas (web/pond.ts), so ripples react at 0ms and the WS stream stays tiny.
export async function startSession(
  streams: SessionStreams,
  onExit: () => void,
  opts?: { volume?: import("./music").VolumeChannel; pond?: boolean },
): Promise<CliRenderer> {
  // re-read per session; getLinkedInSnapshot has its own 30s TTL so new visits get fresh data
  const linkedIn = await getLinkedInSnapshot();
  const visit = recordVisit();
  const distinctId = randomUUID();
  capture(distinctId, "visit", { count: visit.count });

  // Throttle the heavy part (renderer alloc + first render) so simultaneous connects
  // drain a few at a time instead of spiking heap all at once.
  await acquireMount();
  let renderer!: CliRenderer;
  try {
    renderer = await createCliRenderer({
      stdin: streams.stdin,
      stdout: streams.stdout,
      width: streams.width,
      height: streams.height,
      exitOnCtrlC: false,
      exitSignals: [],
      useMouse: true,
      enableMouseMovement: true,
      targetFps: 60,
    });
    // presence: count this live session; decrement once on whatever path tears the renderer down
    join();
    const root = createRoot(renderer);
    const origDestroy = renderer.destroy.bind(renderer);
    let left = false;
    (renderer as unknown as { destroy: () => void }).destroy = () => {
      if (!left) {
        left = true;
        leave();
        // Unmount React so the App's effect cleanups run (pond animation + polling
        // intervals). Without this the timers outlive the session and leak memory.
        try {
          root.unmount();
        } catch {
          // already torn down
        }
      }
      origDestroy();
    };
    root.render(
      <App
        linkedIn={linkedIn}
        visit={visit}
        distinctId={distinctId}
        onExit={onExit}
        volume={opts?.volume}
        pond={opts?.pond}
        allowSavedSessions={false}
      />,
    );
  } finally {
    // hold the slot briefly so this session's first frame + GC settle before the next mounts
    setTimeout(releaseMount, MOUNT_SETTLE_MS);
  }
  return renderer;
}
