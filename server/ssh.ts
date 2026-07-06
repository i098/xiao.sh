import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ssh2 from "ssh2";
import { startSession } from "../tui/session";

const PORT = Number(process.env.SSH_PORT ?? 2222);
// Lives in .data (the PVC in prod) so the fingerprint survives redeploys.
const HOST_KEY_PATH = path.join(process.cwd(), ".data", "ssh-host-key");

// Abuse limits for the public endpoint. Sessions arrive through the fly relay, so
// every client shares one source IP — global caps only.
// ponytail: no per-IP limits; add a PROXY-protocol shim on the relay if one abuser
// ever needs singling out.
const MAX_CLIENTS = 32;
const IDLE_MS = 15 * 60 * 1000; // no keystrokes (output always flows — pond animates)
const MAX_SESSION_MS = 2 * 60 * 60 * 1000;

// Persist a stable host key so clients don't see a changed-fingerprint warning each restart.
function hostKey() {
  if (existsSync(HOST_KEY_PATH)) return readFileSync(HOST_KEY_PATH, "utf8");
  // ssh2's own keygen — node:crypto's PKCS8 ed25519 PEM is not a format ssh2 can parse.
  const { private: privateKey } = ssh2.utils.generateKeyPairSync("ed25519");
  mkdirSync(path.dirname(HOST_KEY_PATH), { recursive: true });
  writeFileSync(HOST_KEY_PATH, privateKey, { mode: 0o600 });
  return privateKey;
}

let activeClients = 0;

const server = new ssh2.Server({ hostKeys: [hostKey()] }, (client) => {
  if (activeClients >= MAX_CLIENTS) {
    client.end();
    return;
  }
  activeClients += 1;
  client.on("close", () => {
    activeClients -= 1;
  });

  // Public portfolio: anyone may connect. We never expose a shell or run commands,
  // only our own TUI, so open auth carries no command-execution risk.
  client.on("authentication", (ctx) => ctx.accept());

  // No tunneling through this box: refuse port-forward requests and channels.
  // (ssh2 auto-rejects unhandled ones; explicit is self-documenting for a public endpoint.)
  client.on("request", (accept, reject) => reject?.());
  client.on("tcpip", (_accept, reject) => reject());
  client.on("openssh.streamlocal", (_accept, reject) => reject());

  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      let cols = 80;
      let rows = 24;
      let hasPty = false;
      let renderer: Awaited<ReturnType<typeof startSession>> | null = null;

      session.on("pty", (acc, _reject, info) => {
        hasPty = true;
        cols = info.cols || cols;
        rows = info.rows || rows;
        acc?.();
      });

      session.on("window-change", (acc, _reject, info) => {
        cols = info.cols || cols;
        rows = info.rows || rows;
        (renderer as unknown as { resize?: (w: number, h: number) => void } | null)?.resize?.(cols, rows);
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

        renderer = await startSession({ stdin: stream, stdout: stream, width: cols, height: rows }, () => {
          try {
            renderer?.destroy();
          } catch {
            // already gone
          }
          stream.end();
        });

        // Reap abandoned/parked sessions: 15 min without a keystroke or 2 h absolute.
        const startedAt = Date.now();
        let lastInput = startedAt;
        stream.on("data", () => {
          lastInput = Date.now();
        });
        const reaper = setInterval(() => {
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

        stream.on("close", () => {
          clearInterval(reaper);
          try {
            renderer?.destroy();
          } catch {
            // already gone
          }
        });
      };
      session.on("shell", serveTui);

      // Terminal ssh-wrappers (Warp, kitty's ssh kitten) request exec with a bootstrap
      // command instead of a plain shell. If they allocated a PTY they're interactive —
      // serve the TUI and ignore the command (nothing is ever executed). Commandless
      // pipes (`ssh host cmd` without -t, sftp) stay rejected.
      session.on("exec", (acc, reject) => {
        if (hasPty && acc) serveTui(acc);
        else reject?.();
      });
      session.on("subsystem", (_a, reject) => reject?.());
    });
  });

  client.on("error", () => {
    // ignore client-side disconnect noise
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ssh terminal on ssh://localhost:${PORT}`);
});
