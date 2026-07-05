import { SEO_HEAD, SEO_BODY, robotsTxt, sitemapXml, llmsTxt } from "./seo";
import { getSpotify } from "@/lib/spotify";
import { getPreviewUrl } from "@/lib/preview";
import { getLinkedInSnapshot } from "@/lib/linkedin";
import { recordVisit } from "@/lib/visits";
import { capture } from "@/lib/analytics";
import { ask, type ChatMessage } from "@/lib/ai";
import { recordQuestion } from "@/lib/questions";
import { getGitHub } from "@/lib/github";
import { beat, liveCount } from "@/lib/presence";

const PORT = Number(process.env.PORT ?? 8787);

// /app.js — the DOM-rendered app: the same tui/*.tsx tree bundled for the browser.
// The plugin re-targets three seams for modules under tui/: the JSX runtime (intrinsic
// box/text/... tags → DOM primitives), the @opentui packages (→ browser shims), and the
// @/lib data modules (→ fetch-based twins; non-twin libs resolve to the real src/lib —
// which also covers Bun.build's tsconfig-paths gap).
const APP_TWINS = new Set(["spotify", "preview", "ai", "sessions", "presence", "github", "analytics", "questions"]);
let appJsCache: string | null = null;
async function appJs(): Promise<string> {
  const dev = process.env.NODE_ENV !== "production";
  if (appJsCache && !dev) return appJsCache;
  const dom = new URL("../web/dom/", import.meta.url).pathname;
  const lib = new URL("../src/lib/", import.meta.url).pathname;
  const result = await Bun.build({
    entrypoints: [new URL("../web/main.ts", import.meta.url).pathname],
    target: "browser",
    minify: !dev,
    define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
    plugins: [
      {
        name: "dom-target",
        setup(b) {
          b.onResolve({ filter: /^react\/jsx(-dev)?-runtime$/ }, (a) =>
            a.importer.includes("/tui/") ? { path: `${dom}jsx-runtime.ts` } : undefined,
          );
          b.onResolve({ filter: /^@opentui\/react$/ }, () => ({ path: `${dom}hooks.ts` }));
          b.onResolve({ filter: /^@opentui\/core$/ }, () => ({ path: `${dom}opentui-core.ts` }));
          b.onResolve({ filter: /^@\/lib\/(.+)$/ }, (a) => {
            const m = a.path.slice("@/lib/".length);
            return { path: APP_TWINS.has(m) ? `${dom}libs/${m}.ts` : `${lib}${m}.ts` };
          });
        },
      },
    ],
  });
  appJsCache = await result.outputs[0].text();
  return appJsCache;
}

// HTML shell for the DOM app (served at /): same aesthetic (bg, CRT overlays, SEO), no xterm.
const APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>xiao.sh</title>${SEO_HEAD}
<link rel="icon" type="image/png" href="/favicon.png" />
<meta name="theme-color" content="#030c0d" />
<style>
  html,body{margin:0;height:100%;background:#030c0d;overflow:hidden;}
  #app{position:fixed;top:0;left:0;right:0;height:100dvh;box-sizing:border-box;filter:brightness(1.08) saturate(1.18);}
  /* #root paints the text grid over the pond canvas (explicit z-index: the canvas must
     never composite above the text); cell size comes from --cw/--lh (metrics.ts) */
  #root{position:absolute;inset:0;z-index:1;color:#e9ece9;font:14px/19px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
        -webkit-font-smoothing:antialiased;}
  #root input::placeholder{color:#2c3531;opacity:1;}
  #root a{cursor:pointer;}
  /* 16px stops iOS auto-zoom on focus; the grid still sizes rows via --lh */
  @media (pointer: coarse){ #root input{font-size:16px;} }
  .crt-overlay{
    position:fixed;inset:0;z-index:10;pointer-events:none;
    background:repeating-linear-gradient(0deg, rgba(0,0,0,0) 0px, rgba(0,0,0,0) 1px, rgba(0,0,0,0.32) 2px);
    animation:crt-flicker 4s steps(40) infinite;
  }
  .crt-vignette{
    position:fixed;inset:0;z-index:9;pointer-events:none;
    background:radial-gradient(140% 140% at 50% 50%, rgba(0,0,0,0) 65%, rgba(0,0,0,0.45) 100%);
  }
  .crt-tint{
    position:fixed;inset:0;z-index:9;pointer-events:none;
    background:rgba(67,240,138,0.04);
    mix-blend-mode:screen;
  }
  @keyframes crt-flicker{0%,100%{opacity:1}48%{opacity:0.97}50%{opacity:0.94}52%{opacity:0.98}}
  @media (prefers-reduced-motion: reduce){
    .crt-overlay{animation:none}
  }
  .seo-content{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}
</style>
</head>
<body>
${SEO_BODY}
<div id="app"><div id="root"></div></div>
<div class="crt-vignette"></div>
<div class="crt-tint"></div>
<div class="crt-overlay"></div>
<script type="module" src="/app.js"></script>
</body>
</html>`;

// /api/now-playing payload, cached 5s so many open tabs don't hammer Spotify
let nowCache: { at: number; body: string } | null = null;
async function nowPlayingJson(): Promise<string> {
  if (nowCache && Date.now() - nowCache.at < 5_000) return nowCache.body;
  const s = await getSpotify();
  const cur = s.isPlaying ? s.current : null;
  // derive the track id from the song url (https://open.spotify.com/track/{id})
  const id = cur?.songUrl?.split("/track/")[1]?.split("?")[0] || null;
  const previewUrl = id && cur ? await getPreviewUrl(id, cur.name, cur.artists[0] ?? "") : null;
  const body = JSON.stringify({
    playing: Boolean(cur),
    name: cur?.name ?? null,
    artists: cur?.artists ?? [],
    previewUrl,
  });
  nowCache = { at: Date.now(), body };
  return body;
}

// Same-origin policy shared by the WS upgrade and all mutating /api routes: the page's
// Origin must be an explicit allowed origin (localhost / PUBLIC_ORIGIN) or its host must
// equal the Host the page was served from (covers LAN IP / tunnel real-device access).
function sameOriginOk(req: Request): boolean {
  const origin = req.headers.get("origin") ?? "";
  const host = req.headers.get("host") ?? "";
  let originHost = "";
  try { originHost = origin ? new URL(origin).host : ""; } catch { originHost = ""; }
  const allowed = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
  if (process.env.PUBLIC_ORIGIN) allowed.add(process.env.PUBLIC_ORIGIN);
  return allowed.has(origin) || (originHost !== "" && originHost === host);
}

// /api/chat proxies OpenRouter, so rate-limit it: token bucket, 10 req/min per IP.
// ponytail: in-memory, cleared wholesale past 10k IPs — fine for a portfolio site.
const chatBuckets = new Map<string, { tokens: number; at: number }>();
function chatAllowed(ip: string): boolean {
  const now = Date.now();
  if (chatBuckets.size > 10_000) chatBuckets.clear();
  const b = chatBuckets.get(ip) ?? { tokens: 10, at: now };
  b.tokens = Math.min(10, b.tokens + ((now - b.at) / 60_000) * 10);
  b.at = now;
  chatBuckets.set(ip, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    // the cat (restored from the old Next.js app's src/app/icon.png) — public/favicon.ico
    // is the untouched create-next-app Vercel icon, don't serve it
    if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.png")
      return new Response(Bun.file("public/favicon.png"), {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
      });
    if (url.pathname === "/app.js")
      return new Response(await appJs(), {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
      });
    // --- data endpoints for the DOM client (thin wrappers over src/lib) ---
    if (url.pathname.startsWith("/api/") && req.method === "POST" && !sameOriginOk(req))
      return new Response("forbidden", { status: 403 });
    if (url.pathname === "/api/boot" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { distinctId?: unknown };
      const distinctId = typeof body.distinctId === "string" ? body.distinctId.slice(0, 64) : "anon";
      const linkedIn = await getLinkedInSnapshot();
      const visit = recordVisit();
      capture(distinctId, "visit", { count: visit.count });
      return json({ linkedIn, visit });
    }
    if (url.pathname === "/api/spotify") return json(await getSpotify());
    if (url.pathname === "/api/preview") {
      const id = url.searchParams.get("id") ?? "";
      const name = url.searchParams.get("name") ?? "";
      const artist = url.searchParams.get("artist") ?? "";
      return json({ url: id ? await getPreviewUrl(id, name, artist) : null });
    }
    if (url.pathname === "/api/github") return json(await getGitHub());
    if (url.pathname === "/api/chat" && req.method === "POST") {
      // Behind the Cloudflare tunnel every request shares the tunnel's socket IP, so prefer
      // CF-Connecting-IP. Direct :8787 access could spoof it, but that surface is LAN-only.
      const ip = req.headers.get("cf-connecting-ip") ?? server.requestIP(req)?.address ?? "?";
      if (!chatAllowed(ip)) return json({ error: "rate limited — try again in a minute" }, 429);
      const body = (await req.json().catch(() => null)) as { messages?: unknown } | null;
      const messages = Array.isArray(body?.messages) ? (body.messages as ChatMessage[]) : null;
      const valid =
        messages &&
        messages.length <= 50 &&
        messages.every(
          (m) =>
            (m?.role === "user" || m?.role === "assistant") &&
            typeof m?.content === "string" &&
            m.content.length <= 2000,
        );
      if (!valid || !messages) return json({ error: "bad request" }, 400);
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      if (lastUser) recordQuestion(lastUser.content);
      return json(await ask(messages));
    }
    if (url.pathname === "/api/presence" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { id?: unknown };
      if (typeof body.id === "string") beat(body.id.slice(0, 64));
      return json({ live: liveCount() });
    }
    if (url.pathname === "/api/event" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as
        | { distinctId?: unknown; event?: unknown; properties?: unknown }
        | null;
      if (body && typeof body.distinctId === "string" && typeof body.event === "string")
        capture(
          body.distinctId.slice(0, 64),
          body.event.slice(0, 64),
          body.properties && typeof body.properties === "object"
            ? (body.properties as Record<string, unknown>)
            : undefined,
        );
      return json({ ok: true });
    }
    if (url.pathname === "/api/now-playing")
      return new Response(await nowPlayingJson(), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    // SEO/GEO endpoints
    if (url.pathname === "/robots.txt") return new Response(robotsTxt(), { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (url.pathname === "/sitemap.xml") return new Response(sitemapXml(), { headers: { "content-type": "application/xml; charset=utf-8" } });
    if (url.pathname === "/llms.txt") return new Response(llmsTxt(), { headers: { "content-type": "text/plain; charset=utf-8" } });
    return new Response(APP_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  },
});

console.log(`web terminal on http://localhost:${PORT}`);
