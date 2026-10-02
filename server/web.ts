// Bun HTTP server for the browser product (local dev, and the self-hosted container).
// Routes live in ./routes (shared with the Cloudflare Worker); this file adds /app.js,
// the favicon, and the listener. Runtime data goes to ./.data via @/lib/store's default.
import { buildAppJs } from "./bundle";
import { handle } from "./routes";

const PORT = Number(process.env.PORT ?? 8787);

let appJsCache: string | null = null;
async function appJs(): Promise<string> {
  const dev = process.env.NODE_ENV !== "production";
  if (appJsCache && !dev) return appJsCache;
  appJsCache = await buildAppJs(dev);
  return appJsCache;
}

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
    // Behind the Cloudflare tunnel every request shares the tunnel's socket IP, so prefer
    // CF-Connecting-IP. Direct :8787 access could spoof it, but that surface is LAN-only.
    const ip = req.headers.get("cf-connecting-ip") ?? server.requestIP(req)?.address ?? "?";
    // Bun keeps the process alive, so background work needs no extra handling here.
    return handle(req, ip, () => {});
  },
});

console.log(`web terminal on http://localhost:${PORT}`);
