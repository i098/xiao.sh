// Browser twin of @/lib/preview: the iTunes-first resolution runs server-side.
export async function getPreviewUrl(trackId: string, name: string, artist: string): Promise<string | null> {
  try {
    const q = `id=${encodeURIComponent(trackId)}&name=${encodeURIComponent(name)}&artist=${encodeURIComponent(artist)}`;
    const r = await fetch(`/api/preview?${q}`);
    const d = (await r.json()) as { url?: string | null };
    return d.url ?? null;
  } catch {
    return null;
  }
}
