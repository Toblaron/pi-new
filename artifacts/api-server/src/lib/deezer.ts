const TIMEOUT_MS = 8000;

export interface DeezerMetadata {
  bpm?: number;
  releaseYear?: string;
}

// Deezer's public search API needs no key. The `bpm` field on track details
// is real but frequently 0 (unset) for many tracks, especially older/less
// mainstream ones — treat 0 as "no data", not "silence".
export async function fetchDeezerMetadata(
  artist: string,
  title: string,
): Promise<DeezerMetadata | null> {
  try {
    const searchUrl = new URL("https://api.deezer.com/search");
    searchUrl.searchParams.set("q", `artist:"${artist}" track:"${title}"`);

    const searchSignal = AbortSignal.timeout(TIMEOUT_MS);
    const searchResp = await fetch(searchUrl.toString(), { signal: searchSignal });
    if (!searchResp.ok) return null;

    const searchData = (await searchResp.json()) as DeezerSearchResponse;
    const match = searchData?.data?.[0];
    if (!match) return null;

    const trackSignal = AbortSignal.timeout(TIMEOUT_MS);
    const trackResp = await fetch(`https://api.deezer.com/track/${match.id}`, { signal: trackSignal });
    if (!trackResp.ok) return null;

    const track = (await trackResp.json()) as DeezerTrackResponse;
    if (!track || track.error) return null;

    const result: DeezerMetadata = {};

    if (typeof track.bpm === "number" && track.bpm > 0) {
      result.bpm = Math.round(track.bpm);
    }
    if (track.release_date) {
      const year = track.release_date.slice(0, 4);
      if (/^\d{4}$/.test(year)) result.releaseYear = year;
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

interface DeezerSearchResponse {
  data?: Array<{ id: number }>;
}

interface DeezerTrackResponse {
  bpm?: number;
  release_date?: string;
  error?: unknown;
}
