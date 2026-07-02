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
<link rel="icon" type="image/png" href="/favicon.png" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css" />
<style>
  html,body{margin:0;height:100%;background:#030c0d;overflow:hidden;}
  /* full-bleed, no inset frame; phosphor punch on the whole screen.
     100dvh + border-box so the terminal fits the *visible* area (above iOS Safari's toolbar)
     and the 6px padding doesn't push the bottom row (the footer) off-screen. */
  #app{position:fixed;top:0;left:0;right:0;height:100dvh;box-sizing:border-box;padding:6px;filter:brightness(1.08) saturate(1.18);}
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
  /* "tap to type" button — shown by JS only on the chat screen on touch devices.
     subtle outlined pill so it doesn't read as a random blob. */
  #kb{display:none;position:fixed;right:10px;bottom:14px;z-index:20;padding:7px 11px;
      border:1px solid rgba(67,240,138,0.55);border-radius:8px;background:rgba(5,8,10,0.88);
      color:#43f08a;font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace;}
  /* real input we focus to summon the phone keyboard (iOS won't open it for xterm's off-screen textarea);
     its keystrokes are forwarded to the terminal. 16px font-size stops iOS auto-zoom. */
  #kbin{position:fixed;bottom:10px;left:10px;width:1px;height:1px;opacity:0;border:0;padding:0;font-size:16px;z-index:19;}
</style>
</head>
<body>
${SEO_BODY}
<div id="app"></div>
<div class="crt-vignette"></div>
<div class="crt-tint"></div>
<div class="crt-overlay"></div>
<div class="crt-scan"></div>
<button id="kb" aria-label="Show keyboard">⌨ type</button>
<textarea id="kbin" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" aria-hidden="true"></textarea>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-canvas@0.7.0/lib/addon-canvas.min.js"></script>
<script>
  // phones get a smaller font so more cols/rows fit (the TUI goes single-column under 64 cols)
  const isPhone = window.matchMedia("(max-width: 600px)").matches;
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: isPhone ? 11 : 14,
    theme: { background: "#030c0d", foreground: "#e9ece9", cursor: "#43f08a" },
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
  ws.onopen = () => { sizeToViewport(); };
  ws.onmessage = (e) => { term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data)); updateKb(); };
  ws.onclose = () => term.write("\\r\\n[connection closed]\\r\\n");
  term.onData((d) => ws.send(enc.encode(d)));
  // size the terminal to the *visible* viewport (handles iOS toolbar + keyboard open/close), then refit
  function sizeToViewport() {
    const vv = window.visualViewport;
    if (vv) document.getElementById("app").style.height = vv.height + "px";
    fit.fit();
    sendResize();
  }
  addEventListener("resize", sizeToViewport);

  // --- touch support (xterm doesn't emit mouse reports for taps, and phones have no keyboard) ---
  const appEl = document.getElementById("app");
  // "tap to type" button → focus a real input to summon the phone keyboard, then forward its
  // keystrokes to the terminal as stdin bytes (opentui's chat input consumes them).
  const kb = document.getElementById("kb");
  const kbin = document.getElementById("kbin");
  let isTouch = window.matchMedia("(pointer: coarse)").matches;
  function summonKeyboard() { if (kbin) kbin.focus(); }
  // only relevant on the chat screen (only place with a text input) and only on touch devices.
  // detect the screen from the header line the TUI prints ("~/chat").
  function onChatScreen() {
    const b = term.buffer.active;
    for (let i = 0; i < 3 && i < b.length; i++) {
      const l = b.getLine(i);
      if (l && l.translateToString(true).includes("/chat")) return true;
    }
    return false;
  }
  function updateKb() { if (kb) kb.style.display = isTouch && onChatScreen() ? "block" : "none"; }
  if (kb) {
    kb.addEventListener("click", summonKeyboard);
    kb.addEventListener("touchend", (e) => { e.preventDefault(); summonKeyboard(); }, { passive: false });
  }
  if (kbin) {
    // printable input (incl. iOS soft keyboard, which doesn't fire real keydowns): send + clear
    kbin.addEventListener("input", () => {
      if (kbin.value) { ws.send(enc.encode(kbin.value.replace(/\\n/g, "\\r"))); kbin.value = ""; }
    });
    // special keys the input event doesn't surface as text
    kbin.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { ws.send(enc.encode("\\r")); e.preventDefault(); }
      else if (e.key === "Backspace") { ws.send(enc.encode("\\x7f")); e.preventDefault(); }
    });
  }
  // translate a tap into an SGR mouse click so opentui's tap targets (footer nav, project list) fire
  function tapToMouse(clientX, clientY, press) {
    const r = appEl.getBoundingClientRect();
    const col = Math.max(1, Math.min(term.cols, Math.floor((clientX - r.left) / (r.width / term.cols)) + 1));
    const row = Math.max(1, Math.min(term.rows, Math.floor((clientY - r.top) / (r.height / term.rows)) + 1));
    ws.send(enc.encode("\\x1b[<0;" + col + ";" + row + (press ? "M" : "m")));
  }
  // capture phase + preventDefault so xterm's own touch handling can't swallow the tap,
  // and so the browser's synthetic mouse/scroll (which would double-fire) is suppressed
  let tap = null;
  appEl.addEventListener("touchstart", (e) => {
    const t = e.touches[0]; if (!t) return;
    e.preventDefault();
    isTouch = true; // confirmed touch device → let updateKb() show the button on chat
    updateKb();
    tap = { x: t.clientX, y: t.clientY };
    tapToMouse(t.clientX, t.clientY, true);
  }, { capture: true, passive: false });
  appEl.addEventListener("touchend", (e) => {
    if (!tap) return;
    e.preventDefault();
    tapToMouse(tap.x, tap.y, false);
    tap = null;
  }, { capture: true, passive: false });
  // refit when the on-screen keyboard opens/closes (visualViewport shrinks) so the input stays visible
  if (window.visualViewport) window.visualViewport.addEventListener("resize", sizeToViewport);
  sizeToViewport();
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
      const host = req.headers.get("host") ?? "";
      let originHost = "";
      try { originHost = origin ? new URL(origin).host : ""; } catch { originHost = ""; }
      const allowed = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
      if (process.env.PUBLIC_ORIGIN) allowed.add(process.env.PUBLIC_ORIGIN);
      // accept our own origin (incl. LAN IP / tunnel): the page's Origin host must equal the
      // Host it was served from — blocks cross-site WS hijacking while allowing real-device access
      const sameOrigin = originHost !== "" && originHost === host;
      if (!allowed.has(origin) && !sameOrigin) return new Response("forbidden", { status: 403 });
      if (server.upgrade(req, { data: { stdin: null, renderer: null, starting: false } })) return;
      return new Response("websocket upgrade failed", { status: 400 });
    }
    // the cat (restored from the old Next.js app's src/app/icon.png) — public/favicon.ico
    // is the untouched create-next-app Vercel icon, don't serve it
    if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.png")
      return new Response(Bun.file("public/favicon.png"), {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
      });
    // SEO/GEO endpoints
    if (url.pathname === "/robots.txt") return new Response(robotsTxt(), { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (url.pathname === "/sitemap.xml") return new Response(sitemapXml(), { headers: { "content-type": "application/xml; charset=utf-8" } });
    if (url.pathname === "/llms.txt") return new Response(llmsTxt(), { headers: { "content-type": "text/plain; charset=utf-8" } });
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
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
