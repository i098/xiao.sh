// Cloudflare Worker entry for the browser product (wrangler.jsonc). Static /app.js and the
// favicon are Workers Static Assets built by server/bundle.ts; everything else runs the
// shared routes with .data backed by the DATA KV namespace. No SSH: Workers carry HTTP only.
// The daily cron (triggers.crons) re-derives the project labels into KV; /api/projects
// serves that copy, so new repos and their GitHub-derived labels reach visitors with no
// rebuild or redeploy. Awards come from the bundled LinkedIn snapshot: redeploy, then wait for
// the next daily refresh (the KV copy wins until then).
import { handle } from "./routes";
import { useStore, type Store } from "@/lib/store";
import { refreshProjects } from "@/lib/projects";

type Env = { DATA: Store; GITHUB_TOKEN?: string };
type Ctx = { waitUntil(p: Promise<unknown>): void };

export default {
  fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    useStore(env.DATA);
    return handle(req, req.headers.get("cf-connecting-ip") ?? "?", (p) => ctx.waitUntil(p));
  },
  async scheduled(_event: unknown, env: Env, ctx: Ctx): Promise<void> {
    useStore(env.DATA);
    const token = env.GITHUB_TOKEN?.trim();
    if (!token) {
      console.warn("projects refresh skipped: GITHUB_TOKEN is not set (serving the committed snapshot)");
      return;
    }
    // a failed run keeps the previous KV copy; the error lands in Workers logs
    ctx.waitUntil(refreshProjects(token).then((n) => console.log(`projects refreshed: ${n}`)));
  },
};
