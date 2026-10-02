// Cloudflare Worker entry for the browser product (wrangler.jsonc). Static /app.js and the
// favicon are Workers Static Assets built by server/bundle.ts; everything else runs the
// shared routes with .data backed by the DATA KV namespace. No SSH: Workers carry HTTP only.
import { handle } from "./routes";
import { useStore, type Store } from "@/lib/store";

export default {
  fetch(req: Request, env: { DATA: Store }, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    useStore(env.DATA);
    return handle(req, req.headers.get("cf-connecting-ip") ?? "?", (p) => ctx.waitUntil(p));
  },
};
