// Spotify now-playing for the TUI (server-side). Ports the web app's API route logic and
// adds a recently-played fallback so the home screen always has something to show.
// Reads SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / SPOTIFY_REFRESH_TOKEN; no-op without them.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const NOW_URL = "https://api.spotify.com/v1/me/player/currently-playing";
const RECENT_URL = "https://api.spotify.com/v1/me/player/recently-played?limit=6";
const QUEUE_URL = "https://api.spotify.com/v1/me/player/queue";

export type SpotifyTrack = {
  id: string | null;
  name: string;
  artists: string[];
  album: string | null;
  songUrl: string | null;
  imageUrl: string | null;
};

export type SpotifyEntry = { track: SpotifyTrack; playedAt: string | null };

export type SpotifyState = {
  configured: boolean;
  isPlaying: boolean;
  current: SpotifyTrack | null; // now playing (if any)
  progressMs: number | null;
  durationMs: number | null;
  recent: SpotifyEntry[]; // most-recently-played, newest first
  queue: SpotifyTrack[]; // up next (only meaningful while playing)
};

const EMPTY = (configured: boolean): SpotifyState => ({
  configured,
  isPlaying: false,
  current: null,
  progressMs: null,
  durationMs: null,
  recent: [],
  queue: [],
});

function env(key: string): string | null {
  const value = process.env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

let tokenCache: { token: string; exp: number } | null = null;

async function getAccessToken(): Promise<string | null> {
  if (tokenCache && tokenCache.exp > Date.now()) return tokenCache.token;
  const id = env("SPOTIFY_CLIENT_ID");
  const secret = env("SPOTIFY_CLIENT_SECRET");
  const refresh = env("SPOTIFY_REFRESH_TOKEN");
  if (!id || !secret || !refresh) return null;

  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (typeof data.access_token !== "string" || !data.access_token) return null;
  tokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000 };
  return data.access_token;
}

type RawArtist = { name?: string };
type RawItem = {
  id?: string;
  name?: string;
  duration_ms?: number;
  external_urls?: { spotify?: string };
  artists?: RawArtist[];
  album?: { name?: string; images?: Array<{ url?: string }> };
};

function trackFrom(item: RawItem | undefined): SpotifyTrack {
  return {
    id: typeof item?.id === "string" ? item.id : null,
    name: typeof item?.name === "string" ? item.name : "",
    artists: (item?.artists ?? []).map((a) => a?.name).filter((n): n is string => Boolean(n)),
    album: typeof item?.album?.name === "string" ? item.album.name : null,
    songUrl: item?.external_urls?.spotify ?? null,
    imageUrl: item?.album?.images?.find((i) => typeof i?.url === "string" && i.url)?.url ?? null,
  };
}

// Shared 5s cache so every TUI session and /api/now-playing poll coalesces into one Spotify
// round-trip — without it a handful of visitors trips Spotify's per-endpoint rate limits (429).
let stateCache: { at: number; state: SpotifyState } | null = null;
// recently-played 429s independently of the other endpoints; history is append-only, so the
// last good copy stays valid — keep serving it instead of blanking the widget's history rows.
// It also only changes when a track finishes, so refetch at most once a minute and honor
// Retry-After (capped at 1h) when Spotify rate-limits it.
let lastRecent: SpotifyEntry[] = [];
let recentFetchedAt = 0;
let recentRetryAt = 0;
// tracks we watched playing, newest first — history fallback while recently-played is rate-limited
let observed: SpotifyEntry[] = [];

// history survives restarts/redeploys: persisted to .data (the prod PVC, same as visits.json).
// Without this every rollout blanked RECENTLY PLAYED until the rate-limited API recovered.
const HISTORY_FILE = path.join(process.cwd(), ".data", "spotify.json");
try {
  const p = JSON.parse(readFileSync(HISTORY_FILE, "utf8")) as {
    lastRecent?: SpotifyEntry[];
    recentFetchedAt?: number;
    recentRetryAt?: number;
    observed?: SpotifyEntry[];
  };
  lastRecent = p.lastRecent ?? [];
  recentFetchedAt = p.recentFetchedAt ?? 0;
  recentRetryAt = p.recentRetryAt ?? 0;
  observed = p.observed ?? [];
} catch {
  // first boot — nothing persisted yet
}
function persistHistory() {
  try {
    mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    writeFileSync(HISTORY_FILE, JSON.stringify({ lastRecent, recentFetchedAt, recentRetryAt, observed }));
  } catch {
    // disk hiccup — in-memory copy still serves
  }
}

// SPOTIFY_MOCK=1 — offline/UI work: nothing playing, 8 fake recent tracks (staggered
// timestamps) so the idle widget and its display cap are visible without hitting Spotify.
function mockState(): SpotifyState {
  // real track ids so the visitor-playback controls resolve live previews per track
  const names: [string, string, string][] = [
    ["Shelter", "Porter Robinson, Madeon", "2ewEh7LuvToYyGHq7yT8N1"],
    ["Sea Of Voices", "Porter Robinson", "2lNFWUrxuNaQsf5I1pDTPr"],
    ["Delete", "Ninajirachi", "0CVbCtcdXAIw00YBXXbneu"],
    ["AMERICAN GIRL", "Tiffany Day", "4mJtdc1xi7VN8Tn7c2aKvI"],
    ["Wayside", "Ninajirachi", "1JowcJWNSlUROxj0lKSd4L"],
    ["All Or Nothing", "aftrr!", "7IFRrcXQA3WTiLtReRxB3y"],
    ["Fragments", "ILLENIUM, Natalie Taylor", "0qH4xYxCrvqO86YyLbkTrB"],
    ["Drown the Sky", "William Black, RØRY", "6s3lekI5yHpDaOWa3QTI8b"],
  ];
  return {
    ...EMPTY(true),
    recent: names.map(([name, artists, id], i) => ({
      track: { id, name, artists: artists.split(", "), album: null, songUrl: `https://open.spotify.com/track/${id}`, imageUrl: null },
      playedAt: new Date(Date.now() - (i + 1) * 17 * 60_000).toISOString(),
    })),
  };
}

export async function getSpotify(): Promise<SpotifyState> {
  if (env("SPOTIFY_MOCK")) return mockState();
  if (stateCache && Date.now() - stateCache.at < 5_000) {
    const { at, state } = stateCache;
    // advance progress by the cache age so consumers never see time run backwards
    if (state.isPlaying && state.progressMs != null && state.durationMs != null)
      return { ...state, progressMs: Math.min(state.durationMs, state.progressMs + (Date.now() - at)) };
    return state;
  }
  const state = await fetchSpotify();
  if (state.configured) stateCache = { at: Date.now(), state };
  return state;
}

async function fetchSpotify(): Promise<SpotifyState> {
  try {
    const token = await getAccessToken();
    if (!token) return EMPTY(false);
    const auth = { Authorization: `Bearer ${token}` };
    let current: SpotifyTrack | null = null;
    let isPlaying = false;
    let progressMs: number | null = null;
    let durationMs: number | null = null;

    const nowRes = await fetch(NOW_URL, { headers: auth, signal: AbortSignal.timeout(5000) });
    if (nowRes.status === 200) {
      const data = (await nowRes.json()) as { is_playing?: boolean; currently_playing_type?: string; progress_ms?: number; item?: RawItem };
      if (data?.item && data.currently_playing_type === "track" && data.is_playing) {
        current = trackFrom(data.item);
        isPlaying = true;
        progressMs = typeof data.progress_ms === "number" ? data.progress_ms : null;
        durationMs = typeof data.item.duration_ms === "number" ? data.item.duration_ms : null;
      }
    }

    if (current && observed[0]?.track.name !== current.name)
      observed = [{ track: current, playedAt: new Date().toISOString() }, ...observed].slice(0, 8);
      persistHistory();

    // queue only matters while playing; recent is throttled — most polls are a single request
    const wantRecent = Date.now() - recentFetchedAt > 60_000 && Date.now() >= recentRetryAt;
    const [recRes, queueRes] = await Promise.all([
      wantRecent ? fetch(RECENT_URL, { headers: auth, signal: AbortSignal.timeout(5000) }).catch(() => null) : null,
      isPlaying ? fetch(QUEUE_URL, { headers: auth, signal: AbortSignal.timeout(5000) }).catch(() => null) : null,
    ]);

    let recent: SpotifyEntry[] = lastRecent.length ? lastRecent : observed;
    if (recRes?.ok) {
      const data = (await recRes.json()) as { items?: Array<{ track?: RawItem; played_at?: string }> };
      recent = (data?.items ?? [])
        .filter((it) => it?.track)
        .map((it) => ({ track: trackFrom(it.track), playedAt: typeof it.played_at === "string" ? it.played_at : null }));
      lastRecent = recent;
      recentFetchedAt = Date.now();
      persistHistory();
    } else if (recRes?.status === 429) {
      const after = Number(recRes.headers.get("retry-after")) || 60;
      recentRetryAt = Date.now() + Math.min(after, 3600) * 1000;
      persistHistory();
    }

    let queue: SpotifyTrack[] = [];
    if (queueRes?.ok) {
      const data = (await queueRes.json().catch(() => null)) as { queue?: RawItem[] } | null;
      queue = (data?.queue ?? []).slice(0, 2).map((it) => trackFrom(it));
    }

    return { configured: true, isPlaying, current, progressMs, durationMs, recent, queue };
  } catch {
    return { ...EMPTY(true), recent: lastRecent };
  }
}
