// Spotify now-playing for the TUI (server-side). Ports the web app's API route logic and
// adds a recently-played fallback so the home screen always has something to show.
// Reads SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / SPOTIFY_REFRESH_TOKEN; no-op without them.
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const NOW_URL = "https://api.spotify.com/v1/me/player/currently-playing";
const RECENT_URL = "https://api.spotify.com/v1/me/player/recently-played?limit=5";

export type SpotifyTrack = {
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
};

const EMPTY = (configured: boolean): SpotifyState => ({
  configured,
  isPlaying: false,
  current: null,
  progressMs: null,
  durationMs: null,
  recent: [],
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
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (typeof data.access_token !== "string" || !data.access_token) return null;
  tokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000 };
  return data.access_token;
}

type RawArtist = { name?: string };
type RawItem = {
  name?: string;
  duration_ms?: number;
  external_urls?: { spotify?: string };
  artists?: RawArtist[];
  album?: { name?: string; images?: Array<{ url?: string }> };
};

function trackFrom(item: RawItem | undefined): SpotifyTrack {
  return {
    name: typeof item?.name === "string" ? item.name : "",
    artists: (item?.artists ?? []).map((a) => a?.name).filter((n): n is string => Boolean(n)),
    album: typeof item?.album?.name === "string" ? item.album.name : null,
    songUrl: item?.external_urls?.spotify ?? null,
    imageUrl: item?.album?.images?.find((i) => typeof i?.url === "string" && i.url)?.url ?? null,
  };
}

export async function getSpotify(): Promise<SpotifyState> {
  const token = await getAccessToken();
  if (!token) return EMPTY(false);
  const auth = { Authorization: `Bearer ${token}` };
  try {
    let current: SpotifyTrack | null = null;
    let isPlaying = false;
    let progressMs: number | null = null;
    let durationMs: number | null = null;

    const [nowRes, recRes] = await Promise.all([
      fetch(NOW_URL, { headers: auth }),
      fetch(RECENT_URL, { headers: auth }),
    ]);

    if (nowRes.status === 200) {
      const data = (await nowRes.json()) as { is_playing?: boolean; currently_playing_type?: string; progress_ms?: number; item?: RawItem };
      if (data?.item && data.currently_playing_type === "track" && data.is_playing) {
        current = trackFrom(data.item);
        isPlaying = true;
        progressMs = typeof data.progress_ms === "number" ? data.progress_ms : null;
        durationMs = typeof data.item.duration_ms === "number" ? data.item.duration_ms : null;
      }
    }

    let recent: SpotifyEntry[] = [];
    if (recRes.ok) {
      const data = (await recRes.json()) as { items?: Array<{ track?: RawItem; played_at?: string }> };
      recent = (data?.items ?? [])
        .filter((it) => it?.track)
        .map((it) => ({ track: trackFrom(it.track), playedAt: typeof it.played_at === "string" ? it.played_at : null }));
    }

    return { configured: true, isPlaying, current, progressMs, durationMs, recent };
  } catch {
    return EMPTY(true);
  }
}
