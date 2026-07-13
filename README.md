# xiao.sh

Portfolio as a terminal app (TUI), built with [OpenTUI](https://github.com/anomalyco/opentui) + React on Bun.
Reachable two ways from the same app: over SSH, or in the browser via an xterm.js ↔ websocket bridge.

## Run

```bash
bun install

bun run tui     # standalone, in your own terminal
bun run start   # serve both: web terminal (:8787) + ssh (:2222)
bun run web     # web terminal only
bun run ssh     # ssh only
```

- Browser: open `http://localhost:8787` — you land directly in the TUI.
- SSH: `ssh -p 2222 guest@localhost` (any username; auth is open, only the TUI is served — no shell/exec).

Keys: `h` home · `p` projects (`j`/`k` to move) · `a` about · `c` chat · `q` quit.
Chat slash commands: `/help` · `/clear` · `/save [name]` · `/resume [name]` · `/delete [name]` · `/exit`.

## Layout

- App UI: `tui/app.tsx` · entry `tui/main.tsx` · per-session renderer `tui/session.tsx`
- Servers: `server/web.ts` (Bun HTTP+WS+xterm, + SEO surface in `server/seo.ts`), `server/ssh.ts` (ssh2), `server/index.ts` (both)
- Data/AI/metrics (shared): `src/lib/` (`profile`, `projects`, `linkedin`, `ai`, `spotify`, `github`, `visits`, `presence`, `analytics`, `sessions`, `questions`), `src/data/`

## Config

Copy `.env.example` to `.env` (Bun auto-loads it). All optional except chat needs OpenRouter.

- `OPENROUTER_API_KEY` — chat AI (`src/lib/ai.ts`). Without it, chat shows a config message; everything else works.
- `POSTHOG_API_KEY` (+ `POSTHOG_HOST`) — server-side analytics (visit / nav events).
- `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` / `SPOTIFY_REFRESH_TOKEN` — home now-playing widget. Get the refresh token with `bun run spotify:auth` (register `http://127.0.0.1:8888/callback` in your Spotify app first).
- `LINKEDIN_COOKIE_LI_AT` or `LINKEDIN_STORAGE_STATE_PATH` — full LinkedIn profile scraping.

Runtime state (visit counter, saved chat sessions) is written to `.data/` (gitignored).

## SEO / GEO

The web terminal page is JS (not crawlable), so `server/seo.ts` injects meta + `Person` JSON-LD + a
hidden content block, and serves `/robots.txt`, `/sitemap.xml`, `/llms.txt`. Set `PUBLIC_ORIGIN`
(e.g. `https://xiao.sh`) in production so the URLs and WS origin allowlist are correct.

## LinkedIn data

The About screen + AI context read a Playwright-generated snapshot.

```bash
bun run sync:linkedin            # writes src/data/linkedin-about.json
bun run create:linkedin-session  # interactive session capture (optional)
bun run fetch:linkedin-assets    # pull post images/thumbnails
```

Without auth cookies the sync falls back to public metadata + post-derived context.

## Edit content

- Profile: `src/lib/profile.ts`
- Projects: `src/lib/projects.ts`
- LinkedIn snapshot loader: `src/lib/linkedin.ts`

## License

Licensed under the [Apache License 2.0](LICENSE).
