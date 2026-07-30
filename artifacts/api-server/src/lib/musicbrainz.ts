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
    // limit=25, not 5: for songs with many re-releases/remasters (compilations, anniversary
    // reissues, etc. all sharing the same title+artist and MusicBrainz's max relevance score),
    // the true original is often not in the first 5 results — MusicBrainz's default ordering is
    // relevance, not date. Verified empirically: a-ha's "Take On Me" (1985) has 95 total
    // matching recordings; every one of the top 5 by relevance was a 2000s-2010s re-release,
    // causing era detection to land on "2000s" instead of "80s". See releaseYear below, which
    // scans across all fetched recordings for this reason rather than trusting the single
    // duration-matched "best" recording used for genres/label/album.
    const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&fmt=json&limit=25&inc=releases+genres+isrcs`;
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

    // Original release year: earliest date across ALL fetched recordings' releases, not just
    // the duration-matched "best" one — a remaster/re-issue can duration-match closely while
    // still being decades newer than the true original. This is specifically about dating the
    // song, so it's decoupled from the "best" recording used for genres/label/album/isrc below.
    const allDates = data.recordings
      .flatMap((r) => r.releases ?? [])
      .map((r) => r.date)
      .filter(Boolean)
      .sort() as string[];
    const releaseYear = allDates[0]?.slice(0, 4);

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
