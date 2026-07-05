// Browser twin of @/lib/spotify (aliased by the /app.js build plugin): the server keeps
// tokens + caching; the client just fetches. Never throws — degrades to the last state.
import type { SpotifyState, SpotifyTrack } from "../../../src/lib/spotify";
export type { SpotifyState, SpotifyTrack };

let last: SpotifyState = {
  configured: false,
  isPlaying: false,
  current: null,
  progressMs: null,
  durationMs: null,
  recent: [],
  queue: [],
};

export async function getSpotify(): Promise<SpotifyState> {
  try {
    const r = await fetch("/api/spotify");
    if (r.ok) last = (await r.json()) as SpotifyState;
  } catch {}
  return last;
}
