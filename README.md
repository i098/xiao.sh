# xiao.sh

A personal portfolio rendered as a terminal app.
It is one [OpenTUI](https://github.com/anomalyco/opentui) + React application that you can reach two ways: over SSH, or in a browser.
Both surfaces run the exact same `tui/app.tsx` tree.
Over SSH it is rendered server-side and streamed down the channel; in the browser the same React tree is bundled to DOM primitives and rendered client-side, fetching data over `/api/*`.

Try the live one: open [https://xiao.sh](https://xiao.sh) and you land straight in the TUI.
The public site runs on Cloudflare Workers, which carry HTTP only, so it is browser-only; the SSH surface runs when you self-host it (`bun run start` / `bun run ssh`).

## Features

- One app, two transports.
  The SSH server renders the app with OpenTUI and streams it; the web page ships the same tree compiled to DOM elements and renders it locally, so keystrokes are handled with zero round-trips.
- An animated koi pond behind every screen.
  Koi swim in from the edges, flee the cursor, and leave wave-sim ripples over a slowly drifting water texture (a cellular web of light, carried over from the Subliminal Labs hiring page; `src/lib/texture.ts`), which keeps clear of the header, the footer, and every line of copy.
  Over SSH it is drawn server-side straight into the renderer's cell buffers each frame; in the browser it runs client-side on the same text grid, so ripples react instantly and nothing is streamed for it.
- A Projects screen that labels itself: every public repo of the author and his hackathon team org is pulled from GitHub, and title, summary, category, stack, award, status and role are derived by rule (`src/lib/project-labels.ts`), with wins matched from LinkedIn honours.
  A daily cron re-derives the labels on Cloudflare, so new repos and their GitHub-derived labels appear with no redeploy; awards come from the LinkedIn snapshot, so they update once that snapshot is synced, the Worker is redeployed and the next daily refresh has run (the KV copy wins until then).
- An About screen built from the same data: the name banner, current build, last win, hackathon wins, and the languages he writes, weighted by his commits.
- AI chat about the author, backed by [OpenRouter](https://openrouter.ai).
  It discovers free models, rotates through a pool, and retries across models on rate-limits and transient errors.
  A global rate and concurrency cap keeps a flood of visitors from hammering the upstream API.
- A Spotify now-playing widget on the home screen (current track, recent history, up-next queue).
  In the browser you can play a short track preview through the tab and watch an audio-reactive volume bar; over SSH the same widget and controls render, but no audio can reach the client.
- A live GitHub pulse on the home screen (commits, contributions, stars, last push).
- Live presence: a count of everyone currently connected, across both SSH and web sessions.
- A visitor counter with a 14-day sparkline, persisted to `.data/` locally or to KV on Cloudflare.
- Saved chats in the browser and standalone TUI; persistence is disabled on public SSH because visitors have no identity boundary.
- Hard SSH connection/session caps, bounded terminal sizes and chat input, plus authentication, idle, and absolute timeouts.
- LinkedIn profile scraping (via Playwright) that feeds the About screen and the AI's context, with a baked-in snapshot as a fallback.
- An SEO/GEO surface for a page that is otherwise not crawlable: real meta tags, `Person` JSON-LD, a hidden content block, and `/robots.txt`, `/sitemap.xml`, `/llms.txt`.
- Server-side product analytics via [PostHog](https://posthog.com) (optional).

## Quickstart

Requires [Bun](https://bun.sh).

```bash
bun install

bun run tui     # standalone: run the TUI directly in your own terminal
bun run start   # serve both surfaces: web terminal (:8787) + ssh (:2222)
bun run web     # web terminal only (:8787)
bun run ssh     # ssh only (:2222)
```

- Browser: open `http://localhost:8787` and you land directly in the TUI.
- SSH: `ssh -p 2222 guest@localhost`.
  Any username works and auth is open, because the server only ever serves its own TUI - it never opens a shell or runs commands.

Chat needs an OpenRouter key; everything else runs without any configuration.
Copy the example env file to enable the rest:

```bash
cp .env.example .env
```

Bun auto-loads `.env`.

### Keys

- Navigate: `h` home, `p` projects, `a` about, `c` chat, `q` quit (`Ctrl-C` also quits).
  `<-` / `->` cycle screens where they are not otherwise bound.
- Home: `<-` / `->` browse tracks, `up` / `down` adjust volume.
- Projects: `up` / `down` or `j` / `k` to move the selection.
- Chat: type a question and press Enter; `Esc` returns home; `PageUp` / `PageDown` (or `up` / `down` on an empty input) scroll the history.
- Chat slash commands: `/help`, `/clear`, `/save [name]`, `/resume [name]`, `/delete [name]`, `/exit`.
  Saved-chat commands are available in the browser and standalone TUI, not on public SSH.
  Navigation commands work too: `/home`, `/projects`, `/about`, `/chat`.

## Configuration

Every variable is optional except that AI chat needs `OPENROUTER_API_KEY`.
See `.env.example` for the full annotated list.

- `OPENROUTER_API_KEY` enables the AI chat screen.
  Without it, chat replies with a "not configured" message and every other feature still works.
- `OPENROUTER_MODELS`, `OPENROUTER_DYNAMIC_MODELS`, `OPENROUTER_MODEL_POOL_SIZE`, `OPENROUTER_SITE_URL`, `OPENROUTER_SITE_NAME` tune the free-model rotation pool and the attribution headers.
- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN` power the now-playing widget.
  Without them the widget stays empty.
  Get a refresh token with `bun run spotify:auth`.
- `GITHUB_TOKEN` raises the unauthenticated GitHub API rate limit used by the home-screen pulse, and is required by the daily project-label refresh (GitHub GraphQL needs a token; any token that can read public repos works).
  Without it the pulse runs unauthenticated (60 requests/hour per IP, shared across tenants on Cloudflare's egress IPs); while rate-limited the GitHub line shows the last good value or `…`, never a made-up 0. The Projects screen then serves the committed snapshot.
- `LINKEDIN_COOKIE_LI_AT`, `LINKEDIN_COOKIE_JSESSIONID`, `LINKEDIN_STORAGE_STATE_PATH` enable full LinkedIn profile scraping.
  Without them the sync falls back to public/limited metadata, or to the baked-in snapshot.
- `POSTHOG_API_KEY` (with optional `POSTHOG_HOST`) enables server-side analytics (visit and nav events).
  It is a no-op without the key.
- `PORT` sets the web port (default `8787`).
- `SSH_PORT` sets the ssh port (default `2222`).
- `PUBLIC_ORIGIN` should be your production origin (e.g. `https://xiao.sh`).
  It sets the SEO/GEO URLs and the same-origin allowlist for the mutating `/api/*` routes.
- `NODE_ENV=production` caches the minified browser bundle instead of rebuilding it per request.

Runtime state goes through `src/lib/store.ts`.
Locally it is written to `.data/` (gitignored): the visit counter (`visits.json`), aggregated chat questions (`questions.json`), Spotify history (`spotify.json`), the last good GitHub pulse (`github.json`), the daily project labels (`projects.json`, written by the Worker cron), saved chats (`sessions/`), and a stable ssh host key (`ssh-host-key`).
On Cloudflare the same keys live in the `DATA` KV namespace (see [Cloudflare](#cloudflare)).

## Project layout

- `tui/` - the app itself.
  `app.tsx` holds every screen, keybinding, and the koi-pond composite; `main.tsx` is the standalone entry; `session.tsx` renders one session onto any transport (with mount throttling and presence bookkeeping); `music.tsx` and `ui.tsx` are the widgets and shared styling.
- `server/` - the entry points.
  `index.ts` runs both surfaces plus the LinkedIn refresh loop; `routes.ts` holds the HTML shell, `/api/*` data routes, and SEO routes shared by both web hosts; `web.ts` is the Bun HTTP server; `worker.ts` is the Cloudflare Worker; `bundle.ts` builds the browser bundle; `ssh.ts` is the ssh2 server (session caps, reaping); `seo.ts` builds the meta, JSON-LD, and text files.
- `web/` - the browser build seams.
  `main.ts` boots the DOM render; `dom/` holds the JSX-runtime and OpenTUI shims, cell metrics, the client-side pond, the volume channel, and fetch-based twins of the data libs.
- `src/lib/` - shared data and logic used by both surfaces: `profile`, `projects`, `project-labels`, `linkedin`, `ai`, `spotify`, `github`, `preview`, `visits`, `presence`, `analytics`, `sessions`, `questions`, `store`, `pond`, `texture`, `symbols`.
- `src/data/` - the baked-in LinkedIn snapshot (`linkedin-about.json`), the derived project snapshot (`projects.json`), and the only hand-typed project data (`project-overrides.ts`).
- `scripts/` - the LinkedIn sync/session/asset scripts, the project-label sync, the Spotify auth helper, and `data-to-kv.sh` (copies a `.data` directory into KV).
- `wrangler.jsonc` - the Cloudflare Worker deploy; `fly/`, `k8s/`, and `Dockerfile` - the older self-hosted setup.

## How it works

Both transports render the same `tui/app.tsx` and share everything in `src/lib`, so a session is just a matter of where the tree runs.

- SSH: the ssh2 server accepts any user, never executes commands or exposes an operating-system shell, allocates a PTY, and `startSession()` renders the app with OpenTUI straight onto the ssh channel.
  The koi pond is painted into the renderer's cell buffers each frame.
  New connections are throttled and hard-capped; each client gets one bounded terminal session, and idle (no keystroke for ~5 minutes) or long-lived (2 hours) sessions are reaped.
  Dropped or slept clients are caught by SSH keepalive and closed within ~2 minutes, so a stuck tab frees its slot without waiting on the idle timer.
- Browser: `Bun.build` compiles the same tree for the DOM.
  A plugin rewires three seams for modules under `tui/`: the JSX runtime maps intrinsic `box`/`text`/... tags to DOM elements, the `@opentui/*` packages resolve to browser shims, and a handful of `@/lib` data modules resolve to fetch-based twins.
  `react-dom` then renders it as a text-cell grid client-side, input is handled locally, and data comes over `/api/*`.
  The pond runs on the same grid, so it needs no server round-trip.
- One server process holds the shared live-presence count and the session caps for both surfaces.

### Cloudflare

Production (`https://xiao.sh`) is a Cloudflare Worker (`server/worker.ts`, configured by `wrangler.jsonc`) serving the browser surface only.
SSH is not available there: Workers accept HTTP, not raw TCP.

- `bun server/bundle.ts` (run automatically by `wrangler deploy`) writes the minified `dist/app.js` and favicon, served as static assets.
- Every other request runs `server/routes.ts` in the Worker; runtime state is the `DATA` KV namespace, one key per `.data`-relative file, so `scripts/data-to-kv.sh <dir>` copies a `.data` directory in and verifies each key by sha256 (the ssh host key is skipped).
- A daily Cron Trigger (`triggers.crons` in `wrangler.jsonc`, `scheduled` in `server/worker.ts`) re-derives the project labels into the KV key `projects.json`. `/api/projects` serves that copy (the committed snapshot when it is absent), and the browser reads it through its twin `web/dom/libs/projects.ts`, so new repos and their GitHub-derived labels reach visitors with no rebuild or redeploy. Awards are matched against the bundled LinkedIn snapshot, so a new win shows only after that snapshot is synced, the Worker is redeployed and the next daily refresh has run (the KV copy wins until then). A failed run keeps the previous copy.
- Secrets (`OPENROUTER_API_KEY`, `SPOTIFY_*`, `POSTHOG_*`, `GITHUB_TOKEN`) are Worker secrets set with `wrangler secret put` or `wrangler secret bulk`; they are never in the repo or the bundle.
- Live presence and the chat rate limit are per Worker isolate, and KV is eventually consistent, so the visit counter can drop an increment under concurrent visits.

```bash
CLOUDFLARE_ACCOUNT_ID=... bun run deploy:cf   # plus CLOUDFLARE_API_TOKEN, or CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL
```

The first `bun run deploy:cf` with the `xiao.sh` and `www.xiao.sh` custom-domain routes is the cutover: it takes over both hostnames from the tunnel CNAMEs. Run it only after the bridge container and its cloudflared tunnel are stopped, the final `.data` has been copied into KV with `scripts/data-to-kv.sh`, and the existing `xiao.sh` and `www.xiao.sh` DNS records (the tunnel CNAMEs) have been deleted, since a custom-domain deploy fails while a DNS record exists for the hostname.

The older self-hosted setup exposed the browser side through a cloudflared tunnel and fronted SSH with a fly.io edge running frp (`ssh tui.xiao.sh`); see `fly/README.md` and `fly/` and `k8s/` for the manifests.

## Editing content and data

- Profile: `src/lib/profile.ts` (name, role, education, location, skills, links).
- Projects: nothing to hand-label. `bun run sync:projects` re-derives every label from GitHub and LinkedIn honours into the committed snapshot `src/data/projects.json` and prints the rule behind each label; on Cloudflare the daily cron does the same into KV. Fix a wrong label with one line in `src/data/project-overrides.ts` (`set` any field, `hide`, or `show`); overrides also apply whenever projects are read, so an edit is live on the next deploy. The same list feeds the AI context and the SEO surface.
- LinkedIn: the loader is `src/lib/linkedin.ts` and the fallback snapshot is `src/data/linkedin-about.json`.

Refresh the LinkedIn data (needs Playwright, plus auth cookies for the full profile):

```bash
bun run sync:linkedin            # writes src/data/linkedin-about.json
bun run create:linkedin-session  # interactive session capture (optional)
bun run fetch:linkedin-assets    # pull post images/thumbnails
```

Refresh the project labels (needs a GitHub token):

```bash
GITHUB_TOKEN=$(gh auth token) bun run sync:projects   # writes src/data/projects.json
```

After regenerating photos, `bun test` checks that the published image files stay free of EXIF metadata.

Authorize Spotify once to get a refresh token (register `http://127.0.0.1:8888/callback` as a redirect URI in your Spotify app first):

```bash
bun run spotify:auth
```

## License

Licensed under the [Apache License 2.0](LICENSE).
