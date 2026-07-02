// Preview lookup for a Spotify track. iTunes first: Apple cuts its own segment (a different
// 30s than Spotify's, and some previews run 90s), which is the whole point - then falls back
// to the Spotify embed page's audioPreview. The Web API's preview_url is null (deprecated).
const ITUNES_URL = "https://itunes.apple.com/search?media=music&limit=5&term=";
const EMBED_URL = "https://open.spotify.com/embed/track/";

// ponytail: unbounded cache (incl. null misses), one entry per track ever played - fine for a personal site
const cache = new Map<string, string | null>();

// loose text match: lowercase, strip (parens)/[brackets] qualifiers and punctuation
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function fromItunes(name: string, artist: string): Promise<string | null> {
  if (!name) return null;
  try {
    const res = await fetch(ITUNES_URL + encodeURIComponent(`${name} ${artist}`), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: Array<{ trackName?: string; artistName?: string; previewUrl?: string }> };
    const wantName = norm(name);
    const wantArtist = norm(artist).split(" ")[0] ?? "";
    for (const r of data.results ?? []) {
      if (!r.previewUrl) continue;
      const gotName = norm(r.trackName ?? "");
      const gotArtist = norm(r.artistName ?? "");
      // guard against covers/karaoke hits: the title must line up and the artist must appear
      if (wantName && (gotName.includes(wantName) || wantName.includes(gotName)) && wantArtist && gotArtist.includes(wantArtist))
        return r.previewUrl;
    }
  } catch {
    // search failed - the Spotify embed fallback still applies
  }
  return null;
}

export async function getPreviewUrl(trackId: string, name: string, artist: string): Promise<string | null> {
  if (cache.has(trackId)) return cache.get(trackId) ?? null;

  const itunes = await fromItunes(name, artist);
  if (itunes) {
    cache.set(trackId, itunes);
    return itunes;
  }

  let url: string | null = null;
  try {
    const res = await fetch(EMBED_URL + trackId, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const html = await res.text();
      const key = '"audioPreview":{"url":"';
      const start = html.indexOf(key);
      const end = start === -1 ? -1 : html.indexOf('"', start + key.length);
      // JSON.parse a quoted slice so any \uXXXX escapes in the url decode correctly
      if (end !== -1) url = JSON.parse('"' + html.slice(start + key.length, end) + '"') as string;
      cache.set(trackId, url); // only cache when the page answered - a page without audioPreview is a legit null
    }
  } catch {
    // fetch failed / timed out - don't cache, retry on the next call
  }
  return url;
}
