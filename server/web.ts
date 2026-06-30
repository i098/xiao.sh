import { PassThrough, Writable } from "node:stream";
import { startSession } from "../tui/session";
import { SEO_HEAD, SEO_BODY, robotsTxt, sitemapXml, llmsTxt } from "./seo";

const PORT = Number(process.env.PORT ?? 8787);

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>xiao.sh</title>${SEO_HEAD}
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css" />
<style>
  html,body{margin:0;height:100%;background:#05080a;overflow:hidden;}
  /* full-bleed, no inset frame; phosphor punch on the whole screen */
  #app{position:fixed;inset:0;padding:6px;filter:brightness(1.08) saturate(1.18);}
  .xterm{height:100%;}

  /* CRT scanlines (visible over text) */
  .crt-overlay{
    position:fixed;inset:0;z-index:10;pointer-events:none;
    background:repeating-linear-gradient(0deg, rgba(0,0,0,0) 0px, rgba(0,0,0,0) 1px, rgba(0,0,0,0.32) 2px);
    animation:crt-flicker 4s steps(40) infinite;
  }
  /* gentle vignette (kept off the overlay so it can't read as a hard border) */
  .crt-vignette{
    position:fixed;inset:0;z-index:9;pointer-events:none;
    background:radial-gradient(140% 140% at 50% 50%, rgba(0,0,0,0) 65%, rgba(0,0,0,0.45) 100%);
  }
  /* subtle green phosphor wash to tie text + glow together */
  .crt-tint{
    position:fixed;inset:0;z-index:9;pointer-events:none;
    background:rgba(67,240,138,0.04);
    mix-blend-mode:screen;
  }
  @keyframes crt-flicker{0%,100%{opacity:1}48%{opacity:0.97}50%{opacity:0.94}52%{opacity:0.98}}
  @media (prefers-reduced-motion: reduce){
    .crt-overlay{animation:none}
  }
  /* crawlable content for search / AI bots; off-screen for humans (terminal covers the page) */
  .seo-content{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}
</style>
</head>
<body>
${SEO_BODY}
<div id="app"></div>
<div class="crt-vignette"></div>
<div class="crt-tint"></div>
<div class="crt-overlay"></div>
<div class="crt-scan"></div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-canvas@0.7.0/lib/addon-canvas.min.js"></script>
<script>
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 14,
    theme: { background: "#05080a", foreground: "#e9ece9", cursor: "#43f08a" },
    // honor OSC 8 hyperlinks (short clickable labels) opentui emits; open in a new tab safely.
    // Validate the scheme to block javascript:/data: injection via a crafted link.
    linkHandler: {
      activate(_e, uri) {
        let u;
        try { u = new URL(uri); } catch (e) { return; }
        if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "mailto:") return;
        const w = window.open(u.href, "_blank", "noopener,noreferrer");
        if (w) { try { w.opener = null; } catch (e) {} }
      },
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById("app"));
  // canvas renderer: draws block/half-block glyphs (█ ▀) edge-to-edge so pixel art has no gaps
  try { term.loadAddon(new CanvasAddon.CanvasAddon()); } catch (e) {}
  fit.fit();
  // safety net: auto-link any full http(s):// URL that appears as plain text
  term.loadAddon(new WebLinksAddon.WebLinksAddon());

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(proto + "://" + location.host + "/ws");
  ws.binaryType = "arraybuffer";
  const enc = new TextEncoder();

  function sendResize() {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }
  ws.onopen = () => { fit.fit(); sendResize(); };
  ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
  ws.onclose = () => term.write("\\r\\n[connection closed]\\r\\n");
  term.onData((d) => ws.send(enc.encode(d)));
  addEventListener("resize", () => { fit.fit(); sendResize(); });
</script>
</body>
</html>`;

type SessionData = {
  stdin: PassThrough | null;
  renderer: Awaited<ReturnType<typeof startSession>> | null;
  starting: boolean;
};

Bun.serve<SessionData>({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      // Block cross-site WebSocket hijacking: only allow upgrades from our own origin.
      // Set PUBLIC_ORIGIN (e.g. https://xiao.sh) in production.
      const origin = req.headers.get("origin") ?? "";
      const allowed = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
      if (process.env.PUBLIC_ORIGIN) allowed.add(process.env.PUBLIC_ORIGIN);
      if (!allowed.has(origin)) return new Response("forbidden", { status: 403 });
      if (server.upgrade(req, { data: { stdin: null, renderer: null, starting: false } })) return;
      return new Response("websocket upgrade failed", { status: 400 });
    }
    // SEO/GEO endpoints
    if (url.pathname === "/robots.txt") return new Response(robotsTxt(), { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (url.pathname === "/sitemap.xml") return new Response(sitemapXml(), { headers: { "content-type": "application/xml; charset=utf-8" } });
    if (url.pathname === "/llms.txt") return new Response(llmsTxt(), { headers: { "content-type": "text/plain; charset=utf-8" } });
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
  websocket: {
    async message(ws, message) {
      const data = ws.data;

      // Text frames are control messages (resize). Binary frames are stdin bytes.
      if (typeof message === "string") {
        let control: { type?: string; cols?: number; rows?: number };
        try {
          control = JSON.parse(message);
        } catch {
          return;
        }
        if (control.type !== "resize" || !control.cols || !control.rows) return;

        if (!data.renderer && !data.starting) {
          data.starting = true;
          const stdin = makeStdin();
          const stdout = makeStdout((chunk) => ws.send(chunk));
          stdout.columns = control.cols;
          stdout.rows = control.rows;
          data.stdin = stdin;
          data.renderer = await startSession(
            { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, width: control.cols, height: control.rows },
            () => ws.close(),
          );
          data.starting = false;
        } else if (data.renderer) {
          (data.renderer as unknown as { resize?: (w: number, h: number) => void }).resize?.(control.cols, control.rows);
        }
        return;
      }

      if (data.stdin) data.stdin.write(Buffer.from(message));
    },
    close(ws) {
      try {
        ws.data.renderer?.destroy();
      } catch {
        // already torn down
      }
    },
  },
});

// stdin shim: a readable stream opentui can treat like a raw TTY.
function makeStdin() {
  const stream = new PassThrough() as PassThrough & { setRawMode?: () => unknown; isTTY?: boolean };
  stream.setRawMode = () => stream;
  stream.isTTY = true;
  return stream as PassThrough;
}

// stdout shim: opentui writes ANSI here; we forward each chunk to the websocket.
function makeStdout(send: (chunk: Buffer | string) => void) {
  const stream = new Writable({
    write(chunk, _enc, cb) {
      try {
        send(chunk);
      } catch {
        // socket gone
      }
      cb();
    },
  }) as Writable & { columns?: number; rows?: number; isTTY?: boolean };
  stream.isTTY = true;
  return stream;
}

console.log(`web terminal on http://localhost:${PORT}`);
