import { parse as parseHtml } from "node-html-parser";
import { retryFetch } from "./retryFetch.js";

/** Stage 3 cache payload — lyrics and language. TTL: 7d */
export interface CachedLyrics {
  lyricsText: string | null;
  lyricsSource: "api" | "captions" | "none";
  lyricsProvider?: "genius" | "lrclib" | "lyrics.ovh";
  lyricsHasStructure?: boolean;
  language?: string;
}

/**
 * Fetch lyrics from the free lyrics.ovh API.
 * API: GET https://api.lyrics.ovh/v1/{artist}/{title}
 * Returns { lyrics: string } or { error: string }
 */
async function fetchLyricsFromAPI(artist: string, title: string): Promise<string | null> {
  try {
    const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
    const resp = await retryFetch(url, {
      headers: { "User-Agent": "SunoTemplateGenerator/1.0" },
    }, { maxAttempts: 2, timeoutMs: 8000 });

    if (!resp.ok) return null;

    const data = await resp.json() as { lyrics?: string; error?: string };
    if (!data.lyrics || data.error) return null;

    const lyrics = data.lyrics
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim();

    return lyrics.length > 50 ? lyrics : null;
  } catch {
    return null;
  }
}

/**
 * Fetch lyrics from lrclib.net — higher coverage and reliability than lyrics.ovh.
 * API: GET https://lrclib.net/api/get?artist_name=...&track_name=...&duration=...
 * Falls back to search endpoint if exact match fails.
 */
async function fetchLyricsFromLrcLib(artist: string, title: string, durationSec?: number): Promise<string | null> {
  try {
    // Primary: exact lookup with optional duration for disambiguation
    const params = new URLSearchParams({ artist_name: artist, track_name: title });
    if (durationSec) params.set("duration", String(Math.round(durationSec)));
    const getUrl = `https://lrclib.net/api/get?${params.toString()}`;

    const primaryResp = await retryFetch(getUrl, {
      headers: { "Lrclib-Client": "SunoTemplateGenerator/1.0" },
    }, { maxAttempts: 2, timeoutMs: 8000 });

    if (primaryResp.ok) {
      const data = await primaryResp.json() as { plainLyrics?: string; instrumental?: boolean };
      if (data.instrumental) return null;
      if (data.plainLyrics && data.plainLyrics.length > 50) return data.plainLyrics.trim();
    }

    // Fallback: search
    const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(`${artist} ${title}`)}`;
    const searchResp = await retryFetch(searchUrl, {
      headers: { "Lrclib-Client": "SunoTemplateGenerator/1.0" },
    }, { maxAttempts: 2, timeoutMs: 8000 });
    if (!searchResp.ok) return null;

    const results = await searchResp.json() as Array<{ plainLyrics?: string; instrumental?: boolean }>;
    const best = results.find((r) => !r.instrumental && r.plainLyrics && r.plainLyrics.length > 50);
    return best?.plainLyrics?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Simple heuristic language detector from lyrics text.
 * Checks Unicode character ranges. Falls back to "English".
 */
function detectLanguage(text: string): string {
  if (!text || text.length < 20) return "English";
  const sample = text.slice(0, 600);
  if (/[가-힯]/.test(sample)) return "Korean";
  if (/[぀-ゟ゠-ヿ]/.test(sample)) return "Japanese";
  if (/[一-鿿]/.test(sample)) return "Chinese";
  if (/[؀-ۿ]/.test(sample)) return "Arabic";
  if (/[Ѐ-ӿ]/.test(sample)) return "Russian";
  if (/[฀-๿]/.test(sample)) return "Thai";
  if (/[ऀ-ॿ]/.test(sample)) return "Hindi";
  if (/[ñÑ]/.test(sample)) return "Spanish";
  if (/[çÇèÈêÊ]/.test(sample)) return "French";
  if (/[üÜäÄöÖß]/.test(sample)) return "German";
  if (/[ãÃõÕ]/.test(sample)) return "Portuguese";
  return "English";
}

/**
 * Parse a Genius lyrics HTML container div into plain text.
 * Preserves [Verse 1], [Chorus] etc. section headers embedded in the HTML.
 * Converts <br> to newlines, strips all other tags.
 */
function parseGeniusContainer(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}

/**
 * Fetch song lyrics from Genius.com using the Genius API + page scraping.
 * Returns { lyrics, hasStructure } where hasStructure=true means the lyrics
 * already contain [Verse 1], [Chorus] etc. section tags from Genius.
 */
async function fetchLyricsFromGenius(artist: string, title: string): Promise<{ lyrics: string; hasStructure: boolean } | null> {
  const token = process.env.GENIUS_API_TOKEN;
  if (!token) return null;

  try {
    const searchResp = await fetch(
      `https://api.genius.com/search?q=${encodeURIComponent(`${title} ${artist}`)}`,
      {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": "SunoTemplateGenerator/1.0" },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!searchResp.ok) return null;

    const searchData = await searchResp.json() as {
      response: {
        hits: Array<{
          type: string;
          result: { id: number; url: string; title: string; primary_artist: { name: string }; lyrics_state: string };
        }>;
      };
    };

    const hits = searchData.response.hits.filter((h) => h.type === "song" && h.result.lyrics_state === "complete");
    if (hits.length === 0) return null;

    // Score hits by title/artist similarity
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const nt = norm(title), na = norm(artist);
    const scored = hits.map((h) => {
      const ht = norm(h.result.title), ha = norm(h.result.primary_artist.name);
      let score = 0;
      if (ht === nt) score += 10; else if (ht.includes(nt) || nt.includes(ht)) score += 5;
      if (ha === na) score += 10; else if (ha.includes(na) || na.includes(ha)) score += 5;
      return { h, score };
    }).sort((a, b) => b.score - a.score);

    const bestUrl = scored[0].h.result.url;

    // Fetch and parse the Genius lyrics page
    const pageResp = await fetch(bestUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!pageResp.ok) return null;

    const html = await pageResp.text();
    const root = parseHtml(html);
    const containers = root.querySelectorAll("[data-lyrics-container='true']");
    if (containers.length === 0) {
      console.warn("[genius] no lyrics containers found in page");
      return null;
    }

    let lyrics = "";
    let hasStructure = false;
    for (const container of containers) {
      const text = parseGeniusContainer(container.innerHTML);
      lyrics += text + "\n\n";
      if (/\[(?:Verse|Chorus|Bridge|Pre-?Chorus|Outro|Intro|Hook)\s*\d*\b/i.test(text)) hasStructure = true;
    }

    lyrics = lyrics.trim();
    if (lyrics.length < 50) return null;
    console.log(`[genius] ${artist} – ${title} → ${lyrics.length} chars, structure=${hasStructure}`);
    return { lyrics, hasStructure };
  } catch (err) {
    console.warn("[genius] error:", (err as Error).message?.slice(0, 80));
    return null;
  }
}

/**
 * Fetch lyrics from external providers (Genius → lrclib → lyrics.ovh).
 * Falls back to captions if no lyrics found; falls back to "none" if no captions.
 */
export async function fetchLyricsData(
  cleanArtist: string,
  cleanTitle: string,
  durationSeconds: number | null,
  captionText: string | null,
): Promise<CachedLyrics> {
  const [geniusResult, lrclibLyrics, ovhLyrics] = await Promise.all([
    fetchLyricsFromGenius(cleanArtist, cleanTitle),
    fetchLyricsFromLrcLib(cleanArtist, cleanTitle, durationSeconds ?? undefined),
    fetchLyricsFromAPI(cleanArtist, cleanTitle),
  ]);

  let lyricsText: string | null = null;
  let lyricsProvider: "genius" | "lrclib" | "lyrics.ovh" | undefined;
  let lyricsHasStructure = false;

  if (geniusResult) {
    lyricsText = geniusResult.lyrics;
    lyricsProvider = "genius";
    lyricsHasStructure = geniusResult.hasStructure;
    console.log(`Lyrics via Genius.com (${lyricsText.length} chars, structure=${lyricsHasStructure})`);
  } else if (lrclibLyrics) {
    lyricsText = lrclibLyrics;
    lyricsProvider = "lrclib";
    console.log(`Lyrics via lrclib.net (${lyricsText.length} chars)`);
  } else if (ovhLyrics) {
    lyricsText = ovhLyrics;
    lyricsProvider = "lyrics.ovh";
    console.log(`Lyrics via lyrics.ovh (${lyricsText.length} chars)`);
  }

  if (lyricsText) {
    const language = detectLanguage(lyricsText);
    if (language !== "English") console.log(`Language detected: ${language}`);
    return { lyricsText, lyricsSource: "api", lyricsProvider, lyricsHasStructure, language };
  }
  if (captionText) {
    console.log(`No lyrics found — using YouTube captions (${captionText.length} chars)`);
    const language = detectLanguage(captionText);
    if (language !== "English") console.log(`Language detected from captions: ${language}`);
    return { lyricsText: null, lyricsSource: "captions", language };
  }
  console.log("No lyrics or captions found — relying on AI knowledge");
  return { lyricsText: null, lyricsSource: "none" };
}
