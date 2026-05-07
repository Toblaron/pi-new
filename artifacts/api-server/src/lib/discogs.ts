const TIMEOUT_MS = 8000;
const USER_AGENT = "SunoTemplateGenerator/1.0";

export interface DiscogsMetadata {
  genres: string[];
  styles: string[];
}

export async function fetchDiscogsMetadata(
  artist: string,
  title: string,
): Promise<DiscogsMetadata | null> {
  const token = process.env.DISCOGS_TOKEN;
  if (!token) return null;

  try {
    const query = `${artist} ${title}`;
    const url = new URL("https://api.discogs.com/database/search");
    url.searchParams.set("q", query);
    url.searchParams.set("type", "release");
    url.searchParams.set("per_page", "5");
    url.searchParams.set("token", token);

    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetch(url.toString(), {
      signal,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
      },
    });

    if (!response.ok) return null;

    const data = await response.json() as DiscogsSearchResponse;

    if (!data?.results || data.results.length === 0) return null;

    const topResults = data.results.slice(0, 3);

    const genreSet = new Set<string>();
    const styleSet = new Set<string>();

    for (const result of topResults) {
      if (result.genre) {
        for (const g of result.genre) genreSet.add(g.toLowerCase().trim());
      }
      if (result.style) {
        for (const s of result.style) styleSet.add(s.toLowerCase().trim());
      }
    }

    const genres = Array.from(genreSet).slice(0, 6);
    const styles = Array.from(styleSet).slice(0, 6);

    if (genres.length === 0 && styles.length === 0) return null;

    return { genres, styles };
  } catch {
    return null;
  }
}

interface DiscogsResult {
  genre?: string[];
  style?: string[];
  title?: string;
  year?: string;
}

interface DiscogsSearchResponse {
  results?: DiscogsResult[];
  pagination?: {
    items: number;
    page: number;
    pages: number;
  };
}
