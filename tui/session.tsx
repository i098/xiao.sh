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
  const renderer = await createCliRenderer({
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
  const origDestroy = renderer.destroy.bind(renderer);
  let left = false;
  (renderer as unknown as { destroy: () => void }).destroy = () => {
    if (!left) {
      left = true;
      leave();
    }
    origDestroy();
  };
  createRoot(renderer).render(
    <App linkedIn={linkedIn} visit={visit} distinctId={distinctId} onExit={onExit} volume={opts?.volume} pond={opts?.pond} />,
  );
  return renderer;
}
