// One-shot Spotify OAuth helper: authorize once, capture a long-lived refresh token,
// and append SPOTIFY_REFRESH_TOKEN to .env. Run: `bun run spotify:auth`.
//
// Prereq: in your Spotify app (developer.spotify.com/dashboard) add the redirect URI
//   http://127.0.0.1:8888/callback   (or whatever SPOTIFY_REDIRECT_URI is set to).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const id = process.env.SPOTIFY_CLIENT_ID?.trim();
const secret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
const REDIRECT = process.env.SPOTIFY_REDIRECT_URI?.trim() || "http://127.0.0.1:8888/callback";
const SCOPE = "user-read-currently-playing user-read-playback-state user-read-recently-played";

if (!id || !secret) {
  console.error("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env first.");
  process.exit(1);
}

const redirectUrl = new URL(REDIRECT);
const authUrl = `https://accounts.spotify.com/authorize?${new URLSearchParams({
  client_id: id,
  response_type: "code",
  redirect_uri: REDIRECT,
  scope: SCOPE,
})}`;

// persist the token to .env (replace existing line or append)
function writeRefreshToken(token: string) {
  const envPath = path.join(process.cwd(), ".env");
  let body = "";
  try {
    body = readFileSync(envPath, "utf8");
  } catch {
    // no .env yet
  }
  const line = `SPOTIFY_REFRESH_TOKEN=${token}`;
  if (/^#?\s*SPOTIFY_REFRESH_TOKEN=.*$/m.test(body)) {
    writeFileSync(envPath, body.replace(/^#?\s*SPOTIFY_REFRESH_TOKEN=.*$/m, line));
  } else {
    appendFileSync(envPath, (body.endsWith("\n") || !body ? "" : "\n") + line + "\n");
  }
}

const server = Bun.serve({
  port: Number(redirectUrl.port) || 8888,
  hostname: redirectUrl.hostname,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname !== redirectUrl.pathname) return new Response("waiting for Spotify redirect…");
    const code = u.searchParams.get("code");
    const err = u.searchParams.get("error");
    if (err) {
      console.error("authorization denied:", err);
      return new Response("authorization denied — see terminal");
    }
    if (!code) return new Response("no ?code in callback");

    const basic = Buffer.from(`${id}:${secret}`).toString("base64");
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT }),
    });
    const data = (await res.json()) as { refresh_token?: string; error?: string; error_description?: string };
    if (!data.refresh_token) {
      console.error("token exchange failed:", data);
      return new Response("token exchange failed — see terminal");
    }
    writeRefreshToken(data.refresh_token);
    console.log("\n✓ refresh token captured and written to .env\n");
    queueMicrotask(() => {
      server.stop();
      process.exit(0);
    });
    return new Response("✓ done — refresh token saved. You can close this tab.");
  },
});

console.log(`listening on ${REDIRECT}`);
console.log("\nOpen this URL, log in, and approve:\n\n" + authUrl + "\n");
try {
  Bun.spawn(["open", authUrl]); // macOS; ignore if it fails
} catch {
  // user opens manually
}
