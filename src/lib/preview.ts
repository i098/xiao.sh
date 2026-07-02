// 30s preview mp3 lookup. The Web API's preview_url is null (deprecated), but the public
// embed page still ships an "audioPreview" url in its inline JSON - scrape it from there.
const EMBED_URL = "https://open.spotify.com/embed/track/";

// ponytail: unbounded cache (incl. null misses), one entry per track ever played - fine for a personal site
const cache = new Map<string, string | null>();

export async function getPreviewUrl(trackId: string): Promise<string | null> {
  const hit = cache.get(trackId);
  if (hit !== undefined || cache.has(trackId)) return hit ?? null;
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
      cache.set(trackId, url); // only cache successful lookups - a page without audioPreview is a legit null
    }
  } catch {
    // fetch failed / timed out / bad escape - don't cache, retry on the next call
  }
  return url;
}
