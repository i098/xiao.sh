import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import ssh2 from "ssh2";
import { startSession } from "../tui/session";

const PORT = Number(process.env.SSH_PORT ?? 2222);
const HOST_KEY_PATH = path.join(import.meta.dir, ".host-key");

// Persist a stable host key so clients don't see a changed-fingerprint warning each restart.
function hostKey() {
  if (existsSync(HOST_KEY_PATH)) return readFileSync(HOST_KEY_PATH, "utf8");
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  writeFileSync(HOST_KEY_PATH, privateKey, { mode: 0o600 });
  return privateKey;
}

const server = new ssh2.Server({ hostKeys: [hostKey()] }, (client) => {
  // Public portfolio: anyone may connect. We never expose a shell or run commands,
  // only our own TUI, so open auth carries no command-execution risk.
  client.on("authentication", (ctx) => ctx.accept());

  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      let cols = 80;
      let rows = 24;
      let renderer: Awaited<ReturnType<typeof startSession>> | null = null;

      session.on("pty", (acc, _reject, info) => {
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

      session.on("shell", async (acc) => {
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

        stream.on("close", () => {
          try {
            renderer?.destroy();
          } catch {
            // already gone
          }
        });
      });

      // Ignore exec/subsystem requests: this endpoint only serves the TUI.
      session.on("exec", (_a, reject) => reject?.());
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
