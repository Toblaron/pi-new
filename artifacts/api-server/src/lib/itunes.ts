const TIMEOUT_MS = 8000;

export interface ITunesMetadata {
  genre?: string;
  releaseYear?: string;
  album?: string;
}

// iTunes Search API needs no key. Genre/year data only — no BPM/key.
export async function fetchITunesMetadata(
  artist: string,
  title: string,
): Promise<ITunesMetadata | null> {
  try {
    const url = new URL("https://itunes.apple.com/search");
    url.searchParams.set("term", `${artist} ${title}`);
    url.searchParams.set("media", "music");
    url.searchParams.set("entity", "song");
    url.searchParams.set("limit", "1");

    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetch(url.toString(), { signal });
    if (!response.ok) return null;

    const data = await response.json() as ITunesSearchResponse;
    const match = data?.results?.[0];
    if (!match) return null;

    const result: ITunesMetadata = {};
    if (match.primaryGenreName) result.genre = match.primaryGenreName;
    if (match.releaseDate) {
      const year = match.releaseDate.slice(0, 4);
      if (/^\d{4}$/.test(year)) result.releaseYear = year;
    }
    if (match.collectionName) result.album = match.collectionName;

    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

interface ITunesSearchResponse {
  results?: Array<{
    primaryGenreName?: string;
    releaseDate?: string;
    collectionName?: string;
  }>;
}
