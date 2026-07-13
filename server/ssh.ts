import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server as TcpServer, Socket } from "node:net";
import path from "node:path";
import ssh2 from "ssh2";
import { startSession } from "../tui/session";

const PORT = Number(process.env.SSH_PORT ?? 2222);
// Lives in .data (the PVC in prod) so the fingerprint survives redeploys.
const HOST_KEY_PATH = path.join(process.cwd(), ".data", "ssh-host-key");

// Abuse limits for the public endpoint. Sessions arrive through the fly relay, so
// every client shares one source IP - global caps only.
// ponytail: no per-IP limits; add a PROXY-protocol shim on the relay if one abuser
// ever needs singling out.
// ~14 MB RSS per session (opentui renderer + React tree). At 48 that's ~670 MB,
// leaving headroom under the pod's 2Gi memory limit for the web terminal + base process.
// Raise the k8s memory limit before pushing this higher. CPU (4 cores) only caps
// the pond frame rate under contention, not the ceiling.
const MAX_CLIENTS = 48;
const MAX_TCP_CONNECTIONS = 64;
const AUTH_TIMEOUT_MS = 10_000;
const MIN_COLS = 20;
const MAX_COLS = 240;
const MIN_ROWS = 10;
const MAX_ROWS = 100;
const RESIZE_INTERVAL_MS = 50;
// Reaps parked/backgrounded tabs: output always flows because the pond animates,
// so idle must be measured by keystrokes, not traffic.
const IDLE_MS = 5 * 60 * 1000;
const MAX_SESSION_MS = 2 * 60 * 60 * 1000;

// Self-clearing memory guard. Latch shedding on above the high mark, off once RSS
// falls back under the low mark (hysteresis avoids flapping right at the line). Bun
// RSS is sticky - freed pages linger after sessions leave - so while shedding we force
// a GC before re-sampling to read the true live set, throttled so a flood can't fire a
// GC per connect. ponytail: RSS-after-GC is the honest OOM proxy here; tune the marks
// if the real footprint per session drifts.
const RSS_HIGH_WATER = 1.6 * 1024 * 1024 * 1024; // shed above 80% of the 2Gi pod limit
const RSS_LOW_WATER = 1.2 * 1024 * 1024 * 1024; // resume admitting once back under 60%
const MEM_RECHECK_MS = 2_000; // min gap between forced-GC re-samples while shedding
let memShedding = false;
let lastMemCheck = 0;
function underMemPressure(now: number): boolean {
  if (!memShedding) {
    memShedding = process.memoryUsage().rss > RSS_HIGH_WATER;
    return memShedding;
  }
  // already shedding: periodically reclaim sticky pages, then re-check the low mark
  if (now - lastMemCheck >= MEM_RECHECK_MS) {
    lastMemCheck = now;
    Bun.gc(true); // synchronous full GC so the RSS read reflects the live set
    memShedding = process.memoryUsage().rss > RSS_LOW_WATER;
  }
  return memShedding;
}

const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 100; // >100 new connects / 10s = flood; normal fill to the 48 cap is well under this
const connectTimes: number[] = [];

// Persist a stable host key so clients don't see a changed-fingerprint warning each restart.
function hostKey() {
  if (existsSync(HOST_KEY_PATH)) return readFileSync(HOST_KEY_PATH, "utf8");
  // ssh2's own keygen - node:crypto's PKCS8 ed25519 PEM is not a format ssh2 can parse.
  const { private: privateKey } = ssh2.utils.generateKeyPairSync("ed25519");
  mkdirSync(path.dirname(HOST_KEY_PATH), { recursive: true });
  writeFileSync(HOST_KEY_PATH, privateKey, { mode: 0o600 });
  return privateKey;
}

let activeClients = 0;

function clampDimension(value: number | undefined, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value) || !value) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function peerKey(address: string | undefined, port: number | undefined) {
  return `${address ?? "?"}:${port ?? 0}`;
}

const pendingAuth = new Map<string, { socket: Socket; timer: ReturnType<typeof setTimeout> }>();

// SSH-level keepalive pings traverse the relay to the real client, so a slept/dropped/
// frozen client is closed after ~2 min (interval x countMax), freeing its slot faster
// than the idle reaper and covering connected-but-frozen peers the keystroke-based
// reaper can't see. The client.on("close", release) below frees the slot on that close.
const server = new ssh2.Server({ hostKeys: [hostKey()], keepaliveInterval: 30_000, keepaliveCountMax: 4 }, (client, info) => {
  const key = peerKey(info.ip, info.port);
  const clearAuthDeadline = () => {
    const pending = pendingAuth.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingAuth.delete(key);
  };

  client.on("error", () => {
    // ignore client-side disconnect noise
  });

  // Claim the slot synchronously at connect (before any await) so a burst of
  // simultaneous connections can't all slip past the cap.
  const now = Date.now();
  while (connectTimes.length && now - connectTimes[0] > RATE_WINDOW_MS) connectTimes.shift();
  connectTimes.push(now);
  const overRate = connectTimes.length > RATE_MAX;
  const shed = activeClients >= MAX_CLIENTS || underMemPressure(now) || overRate;
  let counted = false;
  const release = () => {
    if (!counted) return;
    counted = false;
    activeClients -= 1;
  };
  client.on("close", () => {
    clearAuthDeadline();
    release();
  });

  // Reject overload before authentication or renderer allocation. Waiting to show an
  // overflow screen lets stalled clients consume sockets indefinitely.
  if (shed) {
    client.end();
    return;
  }
  activeClients += 1;
  counted = true;

  // Public portfolio: anyone may connect. We never expose a shell or run commands,
  // only our own TUI, so open auth carries no command-execution risk.
  client.on("authentication", (ctx) => ctx.accept());

  // No tunneling through this box: refuse port-forward requests and channels.
  // (ssh2 auto-rejects unhandled ones; explicit is self-documenting for a public endpoint.)
  client.on("request", (accept, reject) => reject?.());
  client.on("tcpip", (_accept, reject) => reject());
  client.on("openssh.streamlocal", (_accept, reject) => reject());

  client.on("ready", () => {
    clearAuthDeadline();
    let sessionOpened = false;
    client.on("session", (accept, reject) => {
      if (sessionOpened) {
        reject();
        return;
      }
      sessionOpened = true;
      const session = accept();
      let cols = 80;
      let rows = 24;
      let hasPty = false;
      let tuiStarted = false;
      let renderer: Awaited<ReturnType<typeof startSession>> | null = null;
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;

      session.on("pty", (acc, _reject, info) => {
        hasPty = true;
        cols = clampDimension(info.cols, MIN_COLS, MAX_COLS, cols);
        rows = clampDimension(info.rows, MIN_ROWS, MAX_ROWS, rows);
        acc?.();
      });

      session.on("window-change", (acc, _reject, info) => {
        cols = clampDimension(info.cols, MIN_COLS, MAX_COLS, cols);
        rows = clampDimension(info.rows, MIN_ROWS, MAX_ROWS, rows);
        if (!resizeTimer) {
          resizeTimer = setTimeout(() => {
            resizeTimer = null;
            (renderer as unknown as { resize?: (w: number, h: number) => void } | null)?.resize?.(cols, rows);
          }, RESIZE_INTERVAL_MS);
        }
        acc?.();
      });

      const serveTui = async (acc: () => unknown) => {
        const stream = acc() as unknown as NodeJS.ReadStream &
          NodeJS.WriteStream & { setRawMode?: () => unknown; isTTY?: boolean; columns?: number; rows?: number };
        // opentui treats this like a raw tty; the ssh channel is a duplex used for both directions.
        stream.isTTY = true;
        stream.setRawMode = () => stream;
        stream.columns = cols;
        stream.rows = rows;

        // Register close teardown before the (possibly mount-throttled) await below, so a
        // client that vanishes mid-queue never leaves a renderer mounted on a dead stream.
        let closed = false;
        let reaper: ReturnType<typeof setInterval> | null = null;
        stream.on("close", () => {
          closed = true;
          if (reaper) clearInterval(reaper);
          if (resizeTimer) clearTimeout(resizeTimer);
          release();
          try {
            renderer?.destroy();
          } catch {
            // already gone
          }
        });

        renderer = await startSession({ stdin: stream, stdout: stream, width: cols, height: rows }, () => {
          try {
            renderer?.destroy();
          } catch {
            // already gone
          }
          stream.end();
        });

        if (closed || stream.destroyed) {
          try {
            renderer.destroy();
          } catch {
            // already gone
          }
          return;
        }

        // Reap abandoned/parked sessions: 5 min without a keystroke or 2 h absolute.
        const startedAt = Date.now();
        let lastInput = startedAt;
        stream.on("data", () => {
          lastInput = Date.now();
        });
        reaper = setInterval(() => {
          const now = Date.now();
          if (now - lastInput > IDLE_MS || now - startedAt > MAX_SESSION_MS) {
            try {
              renderer?.destroy();
            } catch {
              // already gone
            }
            stream.end();
          }
        }, 30_000);
      };
      const startTui = (acc: (() => unknown) | undefined, reject: (() => void) | undefined) => {
        if (!acc || tuiStarted) {
          reject?.();
          return;
        }
        tuiStarted = true;
        void serveTui(acc).catch(() => client.end());
      };
      session.on("shell", (acc, reject) => startTui(acc, reject));

      // Terminal ssh-wrappers (Warp, kitty's ssh kitten) request exec with a bootstrap
      // command instead of a plain shell. If they allocated a PTY they're interactive -
      // serve the TUI and ignore the command (nothing is ever executed). Commandless
      // pipes (`ssh host cmd` without -t, sftp) stay rejected.
      session.on("exec", (acc, reject) => {
        if (hasPty) startTui(acc, reject);
        else reject?.();
      });
      session.on("subsystem", (_a, reject) => reject?.());
    });
  });
});

// ssh2 does not time out clients that stall before sending an SSH header. Attach the
// deadline to its underlying TCP server so it starts before ssh2 parses any bytes.
const tcpServer = (server as unknown as { _srv: TcpServer })._srv;
tcpServer.prependListener("connection", (socket) => {
  const key = peerKey(socket.remoteAddress, socket.remotePort);
  const timer = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS);
  pendingAuth.set(key, { socket, timer });
  socket.once("close", () => {
    const pending = pendingAuth.get(key);
    if (pending?.socket !== socket) return;
    clearTimeout(pending.timer);
    pendingAuth.delete(key);
  });
});
tcpServer.maxConnections = MAX_TCP_CONNECTIONS;
server.on("error", (error: Error) => console.error("ssh server error", error));
server.listen(PORT, "0.0.0.0", () => {
  console.log(`ssh terminal on ssh://localhost:${PORT}`);
});
