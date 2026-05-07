const TIMEOUT_MS = 8000;

// Tags to exclude from results
const EXCLUDED_TAGS = new Set(["seen live", "favourites", "favourite", "favorites"]);
const NUMBERS_ONLY = /^\d+$/;

export async function fetchLastFmTags(artist: string, title: string): Promise<string[] | null> {
  const apiKey = process.env.LASTFM_API_KEY;
  if (!apiKey) return null;

  try {
    const url = new URL("https://ws.audioscrobbler.com/2.0/");
    url.searchParams.set("method", "track.gettoptags");
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("artist", artist);
    url.searchParams.set("track", title);
    url.searchParams.set("format", "json");

    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetch(url.toString(), { signal });

    if (!response.ok) return null;

    const data = await response.json() as LastFmResponse;

    if (!data?.toptags?.tag) return null;

    const tags: string[] = data.toptags.tag
      .filter((t) => typeof t.count === "number" && t.count >= 5)
      .sort((a, b) => (b.count as number) - (a.count as number))
      .slice(0, 8)
      .map((t) => t.name.toLowerCase().trim())
      .filter((name) => !EXCLUDED_TAGS.has(name) && !NUMBERS_ONLY.test(name));

    return tags.length > 0 ? tags : null;
  } catch {
    return null;
  }
}

interface LastFmTag {
  name: string;
  count: number | string;
  url: string;
}

interface LastFmResponse {
  toptags?: {
    tag?: LastFmTag[];
  };
  error?: number;
  message?: string;
}
