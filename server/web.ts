import { PassThrough, Writable } from "node:stream";
import { startSession } from "../tui/session";
import type { VolumeChannel } from "../tui/music";
import { SEO_HEAD, SEO_BODY, robotsTxt, sitemapXml, llmsTxt } from "./seo";
import { getSpotify } from "@/lib/spotify";
import { getPreviewUrl } from "@/lib/preview";

const PORT = Number(process.env.PORT ?? 8787);

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>xiao.sh</title>${SEO_HEAD}
<link rel="icon" type="image/png" href="/favicon.png" />
<meta name="theme-color" content="#030c0d" />
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
    // transparent default bg: unpainted cells become windows onto the koi-pond canvas
    // behind the terminal (/pond.js); text rows keep their opaque PANEL strips.
    allowTransparency: true,
    theme: { background: "#00000000", foreground: "#e9ece9", cursor: "#43f08a" },
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
  // hotkeys work immediately — no click-to-engage. Desktop only: focusing on touch devices
  // would summon the soft keyboard over the page.
  if (!window.matchMedia("(pointer: coarse)").matches) term.focus();
  // safety net: auto-link any full http(s):// URL that appears as plain text
  term.loadAddon(new WebLinksAddon.WebLinksAddon());

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(proto + "://" + location.host + "/ws");
  ws.binaryType = "arraybuffer";
  const enc = new TextEncoder();

  function sendResize() {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }
  ws.onopen = () => { sizeToViewport(); ws.send(JSON.stringify({ type: "vol", value: vol })); }; // seed the TUI bar from localStorage
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

  // --- ambient audio: whisper-quiet 30s Spotify preview of whatever is playing right now ---
  const song = new Audio();
  window.__song = song; // debug handle: inspect ambient-audio state from the console
  song.crossOrigin = "anonymous"; // p.scdn.co sends ACAO:* — lets the analyser read real data
  song.loop = true;
  song.preload = "auto";
  song.volume = 0;
  let songKey = "";        // identity of the current track (name + artists)
  let fadeTimer = null;
  let unlockArmed = false; // one-time autoplay-unlock listeners registered

  // Web Audio graph (built on first gesture — AudioContext needs user activation):
  // song → analyser → gain → speakers. Loudness moves into the gain node so the analyser
  // sees the full-scale signal; setLevel/getLevel abstract over both worlds.
  let actx = null, gainNode = null, analyser = null;
  function setLevel(v) { if (gainNode) gainNode.gain.value = v; else song.volume = v; }
  function getLevel() { return gainNode ? gainNode.gain.value : song.volume; }
  function initAudioGraph() {
    if (actx) return;
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      const src = actx.createMediaElementSource(song);
      analyser = actx.createAnalyser();
      analyser.fftSize = 128; // 64 bins — finer low-end resolution for the 8-rung bar
      analyser.smoothingTimeConstant = 0.55; // default 0.8 is so sluggish the bands flatline
      gainNode = actx.createGain();
      gainNode.gain.value = song.volume;
      src.connect(analyser);
      analyser.connect(gainNode);
      gainNode.connect(actx.destination);
      song.volume = 1; // loudness now lives in the gain node
    } catch (e) { actx = null; gainNode = null; analyser = null; }
  }
  const gestureInit = () => {
    removeEventListener("pointerdown", gestureInit);
    removeEventListener("keydown", gestureInit);
    initAudioGraph();
    if (actx) actx.resume().catch(() => {});
  };
  addEventListener("pointerdown", gestureInit);
  addEventListener("keydown", gestureInit);
  // listening volume: whisper-quiet default (near-silent at ~50% system volume).
  // The TUI renders the volume bar; its changes reach this tab as a private OSC 777 sequence
  // (xterm hands unknown OSCs to registered handlers instead of printing them).
  let vol = 0.04;
  try { const s = parseFloat(localStorage.getItem("xiao-vol")); if (!isNaN(s)) vol = Math.min(1, Math.max(0, s)); } catch (e) {}
  term.parser.registerOscHandler(777, (d) => {
    const v = parseFloat(d);
    if (!isNaN(v)) {
      vol = Math.min(1, Math.max(0, v));
      try { localStorage.setItem("xiao-vol", String(vol)); } catch (e) {}
      if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; } // a bar click overrides any fade in flight
      setLevel(vol);
    }
    return true;
  });
  // OSC 778: visitor-driven playback of my recent tracks (TUI « ▶ » controls while I'm offline).
  // manual=true keeps pollSong's idle path from stopping what the visitor started.
  let manual = false;
  term.parser.registerOscHandler(778, (d) => {
    if (d === "stop") {
      manual = false;
      song.loop = true; // restore ambient behavior
      fadeTo(0, 400, () => { song.pause(); song.removeAttribute("src"); });
    } else if (d.indexOf("play;") === 0) {
      manual = true;
      song.loop = false; // previews play once; the TUI advances to the next track
      song.src = d.slice(5);
      song.play().then(() => fadeTo(vol, 800)).catch(() => {});
    }
    return true;
  });
  function fadeTo(target, ms, done) {
    if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
    if (getLevel() === target) { if (done) done(); return; }
    const step = (target - getLevel()) / (ms / 50);
    fadeTimer = setInterval(() => {
      const v = getLevel() + step;
      if ((step > 0 && v >= target) || (step < 0 && v <= target)) {
        setLevel(target);
        clearInterval(fadeTimer);
        fadeTimer = null;
        if (done) done();
      } else {
        setLevel(v);
      }
    }, 50);
  }
  function startSong(url) {
    song.loop = true; // ambient previews loop while my track plays
    song.src = url;
    const p = song.play();
    // autoplay blocked → retry on the first interaction (terminal users interact immediately)
    if (p && p.catch) p.catch(() => {
      if (unlockArmed) return;
      unlockArmed = true;
      const unlock = () => {
        removeEventListener("pointerdown", unlock);
        removeEventListener("keydown", unlock);
        song.play().then(() => fadeTo(vol, 3000)).catch(() => {});
      };
      addEventListener("pointerdown", unlock);
      addEventListener("keydown", unlock);
    });
    fadeTo(vol, 3000);
  }
  function pollSong() {
    fetch("/api/now-playing").then((r) => r.json()).then((d) => {
      const key = d.playing ? d.name + " - " + d.artists.join(", ") : "";
      document.title = key ? "♫ " + key + " · xiao.sh" : "xiao.sh";
      if (d.playing && d.previewUrl) manual = false; // my live playback takes the audio back
      else if (manual) return;                       // visitor playback owns the idle state
      if (key === songKey) return;
      songKey = key;
      if (d.playing && d.previewUrl) {
        if (song.paused) startSong(d.previewUrl);
        else fadeTo(0, 1000, () => startSong(d.previewUrl));
      } else {
        // drop the src too, or an armed autoplay-unlock handler would replay the stale preview
        fadeTo(0, 1000, () => { song.pause(); song.removeAttribute("src"); });
      }
    }).catch(() => {});
  }
  pollSong();
  setInterval(pollSong, 5000);

  // While a visitor preview plays, feed 8 frequency bands (bass→treble, 0..1) to the TUI so
  // the volume bar dances to the actual music. Silence/absence just means the TUI's own sine
  // animation takes back over (it treats stale data as "no signal").
  // Raw FFT energy is bass-heavy and hugs its own ceiling. Each band is stretched between a
  // floor and ceiling that start at sane music defaults and adapt only slowly and within
  // bounds — fast adaptation either saturates instantly (window snaps to the signal) or
  // collapses the window and turns the bar binary. A wide minimum span keeps it middle-ground:
  // reactive, but only true peaks hit the top.
  const bandLo = new Array(8).fill(0.1);
  const bandHi = new Array(8).fill(0.75);
  setInterval(() => {
    if (!analyser || !manual || song.paused || ws.readyState !== 1) return;
    const bins = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(bins);
    // music lives in the lower ~2/3 of the spectrum (~16kHz at a 48k context); map the
    // 8 bands log-spaced across that instead of wasting the top rungs on empty air
    const span = Math.floor(bins.length * 0.66);
    const bands = [];
    for (let b = 0; b < 8; b++) {
      const s = Math.floor(Math.pow(b / 8, 1.7) * span);
      const e2 = Math.max(s + 1, Math.floor(Math.pow((b + 1) / 8, 1.7) * span));
      let m = 0;
      for (let k = s; k < e2 && k < span; k++) m = Math.max(m, bins[k]);
      const raw = m / 255;
      bandLo[b] = Math.min(raw, bandLo[b] + 0.004, 0.5);                  // floor creeps up, capped
      bandHi[b] = Math.max(raw, bandHi[b] - 0.004, bandLo[b] + 0.4);      // ceiling drifts down, wide min span
      const out = Math.pow(Math.max(0, Math.min(1, (raw - bandLo[b]) / (bandHi[b] - bandLo[b]))), 1.15);
      bands.push(Math.round(out * 100) / 100);
    }
    // all-zero frames (CORS-tainted or silent) are not sent — the TUI falls back to sine
    if (bands.some((x) => x > 0)) ws.send(JSON.stringify({ type: "amp", v: bands }));
  }, 100);

  // handoff for the koi-pond canvas module (/pond.js) — it aligns to this terminal's grid
  window.__term = term;
</script>
<script type="module" src="/pond.js"></script>
</body>
</html>`;

type SessionData = {
  stdin: PassThrough | null;
  renderer: Awaited<ReturnType<typeof startSession>> | null;
  starting: boolean;
  pendingWrites: (() => void)[]; // stdout callbacks held while the socket is congested
  volume: VolumeChannel | null;
  pendingVol: number | null; // client seed that raced the session start
};

// Links the TUI volume bar + preview controls to the tab's <audio>. TUI-originated changes go
// to the browser as OSC 777 (volume) / OSC 778 (visitor playback) — complete escape sequences
// between renderer frames; worst case a garbled frame that the 60fps redraw heals.
// Client-originated volume changes only update subscribers - no echo.
function makeVolume(sendToClient: (seq: string) => void): VolumeChannel {
  let value = 0.04;
  const subs = new Set<(v: number) => void>();
  const ampSubs = new Set<(v: number[]) => void>();
  return {
    get: () => value,
    set(v, source) {
      value = Math.min(1, Math.max(0, v));
      subs.forEach((fn) => fn(value));
      if (source === "tui") sendToClient(`\x1b]777;${value}\x07`);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    play(url) {
      sendToClient(`\x1b]778;${url ? `play;${url}` : "stop"}\x07`);
    },
    feedAmp(v) {
      ampSubs.forEach((fn) => fn(v));
    },
    onAmp(fn) {
      ampSubs.add(fn);
      return () => ampSubs.delete(fn);
    },
  };
}

// /pond.js — the client-side koi pond (web/pond.ts + src/lib/pond.ts) bundled on demand.
// Prod builds once per process; dev rebuilds per request (~10ms) so edits show on reload.
let pondJsCache: string | null = null;
async function pondJs(): Promise<string> {
  const dev = process.env.NODE_ENV !== "production";
  if (pondJsCache && !dev) return pondJsCache;
  const result = await Bun.build({
    entrypoints: [new URL("../web/pond.ts", import.meta.url).pathname],
    target: "browser",
    minify: !dev,
  });
  pondJsCache = await result.outputs[0].text();
  return pondJsCache;
}

// /api/now-playing payload, cached 5s so many open tabs don't hammer Spotify
let nowCache: { at: number; body: string } | null = null;
async function nowPlayingJson(): Promise<string> {
  if (nowCache && Date.now() - nowCache.at < 5_000) return nowCache.body;
  const s = await getSpotify();
  const cur = s.isPlaying ? s.current : null;
  // derive the track id from the song url (https://open.spotify.com/track/{id})
  const id = cur?.songUrl?.split("/track/")[1]?.split("?")[0] || null;
  const previewUrl = id ? await getPreviewUrl(id) : null;
  const body = JSON.stringify({
    playing: Boolean(cur),
    name: cur?.name ?? null,
    artists: cur?.artists ?? [],
    previewUrl,
  });
  nowCache = { at: Date.now(), body };
  return body;
}

Bun.serve<SessionData>({
  port: PORT,
  async fetch(req, server) {
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
      if (server.upgrade(req, { data: { stdin: null, renderer: null, starting: false, pendingWrites: [], volume: null, pendingVol: null } })) return;
      return new Response("websocket upgrade failed", { status: 400 });
    }
    // the cat (restored from the old Next.js app's src/app/icon.png) — public/favicon.ico
    // is the untouched create-next-app Vercel icon, don't serve it
    if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.png")
      return new Response(Bun.file("public/favicon.png"), {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
      });
    // client-side koi pond module
    if (url.pathname === "/pond.js")
      return new Response(await pondJs(), {
        headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
      });
    // now-playing for the browser's ambient audio + tab title
    if (url.pathname === "/api/now-playing")
      return new Response(await nowPlayingJson(), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
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
        let control: { type?: string; cols?: number; rows?: number; value?: number; v?: number[] };
        try {
          control = JSON.parse(message);
        } catch {
          return;
        }
        if (control.type === "vol" && typeof control.value === "number") {
          if (data.volume) data.volume.set(control.value, "client");
          else data.pendingVol = control.value; // session not up yet — apply once it is
          return;
        }
        // live frequency bands from the tab's analyser while a preview plays
        if (control.type === "amp") {
          if (Array.isArray(control.v) && control.v.length && control.v.every((x) => typeof x === "number"))
            data.volume?.feedAmp(control.v.slice(0, 8).map((x) => Math.min(1, Math.max(0, x))));
          return;
        }
        if (control.type !== "resize" || !control.cols || !control.rows) return;

        if (!data.renderer && !data.starting) {
          data.starting = true;
          const stdin = makeStdin();
          const stdout = makeStdout(ws);
          stdout.columns = control.cols;
          stdout.rows = control.rows;
          data.stdin = stdin;
          data.volume = makeVolume((seq) => {
            try { ws.send(seq); } catch { /* socket gone */ }
          });
          if (data.pendingVol != null) data.volume.set(data.pendingVol, "client");
          data.renderer = await startSession(
            { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, width: control.cols, height: control.rows },
            () => ws.close(),
            // pond: false — the browser draws the pond on a local canvas (see /pond.js)
            { volume: data.volume, pond: false },
          );
          data.starting = false;
        } else if (data.renderer) {
          (data.renderer as unknown as { resize?: (w: number, h: number) => void }).resize?.(control.cols, control.rows);
        }
        return;
      }

      if (data.stdin) data.stdin.write(Buffer.from(message));
    },
    drain(ws) {
      // socket caught up — release the renderer's held frame callbacks
      for (const cb of ws.data.pendingWrites.splice(0)) cb();
    },
    close(ws) {
      for (const cb of ws.data.pendingWrites.splice(0)) cb();
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
// The write callback is opentui's flow control: hold it while the socket is congested
// (slow client / bad network) so the renderer skips frames instead of queueing them —
// queued frames render a screen that falls ever further behind and never catches up.
const WS_HIGH_WATER = 128 * 1024; // ~0.75s of koi-pond frames; brief jitter never trips it
function makeStdout(ws: Bun.ServerWebSocket<SessionData>) {
  const stream = new Writable({
    write(chunk, _enc, cb) {
      let r = 1; // send result: >0 sent, 0 dropped (closed), -1 queued under backpressure
      try {
        r = ws.send(chunk);
      } catch {
        // socket gone
      }
      if (r === -1 || ws.getBufferedAmount() > WS_HIGH_WATER) ws.data.pendingWrites.push(cb);
      else cb();
    },
  }) as Writable & { columns?: number; rows?: number; isTTY?: boolean };
  stream.isTTY = true;
  return stream;
}

console.log(`web terminal on http://localhost:${PORT}`);
