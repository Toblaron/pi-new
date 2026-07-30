import { retryFetch } from "./retryFetch.js";

export interface MusicBrainzData {
  releaseYear?: string;
  genres?: string[];
  label?: string;
  album?: string;
  isrc?: string;
}

export async function fetchMusicBrainzData(
  artist: string,
  title: string,
  durationSec?: number,
): Promise<MusicBrainzData> {
  try {
    const query = artist.trim()
      ? `recording:"${title}" AND artist:"${artist}"`
      : `recording:"${title}"`;
    const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&fmt=json&limit=5&inc=releases+genres+isrcs`;
    const resp = await retryFetch(url, {
      headers: {
        "User-Agent": "SunoTemplateGenerator/1.0 (suno-template-gen@example.com)",
        "Accept": "application/json",
      },
    }, { maxAttempts: 2, timeoutMs: 10000, baseDelayMs: 1100 });
    if (!resp.ok) return {};

    const data = await resp.json() as {
      recordings?: Array<{
        title: string;
        length?: number;
        isrcs?: string[];
        genres?: Array<{ name: string; count: number }>;
        releases?: Array<{
          title: string;
          date?: string;
          "label-info"?: Array<{ label?: { name: string } }>;
        }>;
      }>;
    };

    if (!data.recordings || data.recordings.length === 0) return {};

    // Pick best recording by duration proximity if available
    let best = data.recordings[0];
    if (durationSec && data.recordings.length > 1) {
      const targetMs = durationSec * 1000;
      best = data.recordings.reduce((acc, r) => {
        if (!r.length) return acc;
        const diff = Math.abs(r.length - targetMs);
        const accDiff = acc.length ? Math.abs(acc.length - targetMs) : Infinity;
        return diff < accDiff ? r : acc;
      }, data.recordings[0]);
    }

    const releases = best.releases ?? [];
    const dates = releases.map((r) => r.date).filter(Boolean).sort() as string[];
    const releaseYear = dates[0]?.slice(0, 4);
    const genres = (best.genres ?? [])
      .sort((a, b) => b.count - a.count)
      .slice(0, 6)
      .map((g) => g.name);
    const label = releases[0]?.["label-info"]?.[0]?.label?.name;
    const album = releases.find((r) => r.date === dates[0])?.title ?? releases[0]?.title;
    const isrc = best.isrcs?.[0];

    return { releaseYear, genres: genres.length > 0 ? genres : undefined, label, album, isrc };
  } catch {
    return {};
  }
}
