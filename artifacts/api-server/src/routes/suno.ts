import { Router, type IRouter } from "express";
import { GenerateSunoTemplateBody, GenerateSunoTemplateResponse, GenerateVariationsBody, BatchGenerateBody, TransformTemplateBody } from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import ytdl from "@distube/ytdl-core";
import { detectAudioFeatures, dspResultToAudioFeatures, type AudioFeatures } from "../lib/audioFeatures.js";
import { analyzeAudioDsp, checkDspAnalysisAvailable } from "../lib/dspAnalysis.js";
import { decodeHtmlEntities } from "../lib/htmlEntities.js";
import { analyzeLyricsStructure } from "../lib/lyricsStructure.js";
import { computeSuggestedDefaults } from "../lib/suggestedDefaults.js";
import { cacheGet, cacheSet, cacheStats, hashParams, TTL } from "../lib/cache.js";
import { computeFingerprint } from "../lib/fingerprint.js";
import { validateWithPython } from "../lib/pythonValidator.js";
import { fetchLastFmTags } from "../lib/lastfm.js";
import { fetchDiscogsMetadata } from "../lib/discogs.js";
import { fetchTheAudioDB } from "../lib/theaudiodb.js";
import { fetchDeezerMetadata } from "../lib/deezer.js";
import { fetchITunesMetadata } from "../lib/itunes.js";
import { fuseMetadata, type FusedMetadata } from "../lib/metadataFusion.js";
import { retryFetch } from "../lib/retryFetch.js";
import { trackUsage } from "../lib/costTracker.js";
import { computeFeedbackContext } from "../lib/historyStore.js";
import { identifyByFingerprint } from "../lib/acoustid.js";
import { downloadAudioSample, cleanupAudioSample } from "../lib/audioDownload.js";
import { fetchMusicBrainzData, type MusicBrainzData } from "../lib/musicbrainz.js";
import { fetchLyricsData, type CachedLyrics } from "../lib/lyricsProviders.js";
import {
  mapMbTagsToGenres,
  yearToEra,
  inferEnergy,
  inferTempo,
  inferVocals,
  inferInstruments,
  inferMoods,
  inferNudge,
  DEFAULT_GENRES,
  DEFAULT_MOODS,
  DEFAULT_INSTRUMENTS,
} from "../lib/genreInference.js";
import { trimToCharLimit, trimStylePrompt } from "../lib/promptBuilder.js";

const AI_MODEL      = process.env.AI_MODEL      ?? "gpt-4o";
const AI_MINI_MODEL = process.env.AI_MINI_MODEL ?? "gpt-4.1-mini";

const router: IRouter = Router();

interface DescriptionMusicData {
  producedBy?: string;
  writtenBy?: string;
  album?: string;
  label?: string;
  releaseYear?: string;
  bpm?: string;
  key?: string;
}

/** Stage 1 cache payload — base video info, no lyrics, no audio features. TTL: 7d */
interface BaseVideoMetadata {
  title: string;
  author: string;
  description: string;
  keywords: string[];
  category: string;
  duration: string;
  durationSeconds: number | null;
  captionText: string | null;
  cleanTitle: string;
  cleanArtist: string;
  musicBrainz?: MusicBrainzData;
  descriptionData?: DescriptionMusicData;
  fusedMetadata?: FusedMetadata;
}

/** Stage 2 cache payload — audio features only. TTL: permanent (deterministic). */
interface CachedAudioFeatures {
  features: AudioFeatures | null;
}

/** Stage 3 cache payload — lyrics and language. TTL: 7d */
/** Full assembled metadata used throughout the route logic. */
interface VideoMetadata extends BaseVideoMetadata {
  lyricsText: string | null;
  lyricsSource: "user-override" | "api" | "captions" | "none";
  lyricsProvider?: "genius" | "lrclib" | "lyrics.ovh";
  lyricsHasStructure?: boolean;
  language?: string;
  audioFeatures?: AudioFeatures;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Strips common YouTube title suffixes to get a clean song title for lyrics lookup.
 * e.g. "Never Gonna Give You Up (Official Video) (4K Remaster)" → "Never Gonna Give You Up"
 */
// Bracket/paren content that's noise for lookup purposes: quality/format markers, official-upload
// tags, and edit descriptors — matched by keyword since real titles mix them freely in one group,
// e.g. "(Official Video Remastered)" or "[4K UPGRADE]".
const TITLE_NOISE_PATTERN =
  /\s*[([][^)\]]*\b(official(\s+music)?\s+video|official\s+audio|lyrics?|official\s+visuali[sz]er|remaster(ed)?|4k|hd|hq|upgrade|explicit|clean|radio\s+edit|single|album\s+version|visuali[sz]er|live)\b[^)\]]*[)\]]/gi;

const FEATURED_ARTIST_PATTERNS = [
  /\s*-\s*(ft|feat)\.?\s+[^([\n]+/gi,
  /\s*\(ft\.?\s+[^)]+\)/gi,
  /\s*\(feat\.?\s+[^)]+\)/gi,
];

export function cleanSongTitle(rawTitle: string, artistName: string): { cleanTitle: string; cleanArtist: string } {
  let title = rawTitle.trim();
  // YouTube's auto-generated "Artist - Topic" channels are the author for most official
  // audio-only uploads — strip the suffix so lookups query the real artist name.
  let artist = artistName.trim().replace(/\s*-\s*topic$/i, "").trim();

  // Normalize en/em dash variants to a plain " - " so one code path handles both.
  title = title.replace(/\s*[‒–—―]\s*/g, " - ");

  // "Artist - Song": if the leading segment looks like an artist name, split it off.
  // Guard against "Song - feat. X" (a featured-artist suffix, not an Artist-Song split).
  const dashIdx = title.indexOf(" - ");
  if (dashIdx > 0) {
    const leftPart = title.slice(0, dashIdx).trim();
    const rightPart = title.slice(dashIdx + 3).trim();
    if (leftPart.split(" ").length <= 5 && !/^(ft|feat)\.?\s+/i.test(rightPart)) {
      artist = leftPart;
      title = rightPart;
    }
  }

  // "Song (tags) - Artist": a trailing segment that duplicates the known artist is noise, not title.
  const lastDashIdx = title.lastIndexOf(" - ");
  if (lastDashIdx > 0) {
    const tail = title.slice(lastDashIdx + 3).trim();
    if (tail.length > 0 && tail.toLowerCase() === artist.toLowerCase()) {
      title = title.slice(0, lastDashIdx).trim();
    }
  }

  title = title.replace(TITLE_NOISE_PATTERN, "");
  for (const pattern of FEATURED_ARTIST_PATTERNS) {
    title = title.replace(pattern, "");
  }

  return { cleanTitle: title.trim(), cleanArtist: artist.trim() };
}

/**
 * Parse a YouTube video description for embedded music metadata:
 * producer credits, writer credits, album, label, release year, BPM, key.
 */
export function parseDescriptionForMusicData(description: string): DescriptionMusicData {
  if (!description) return {};
  const result: DescriptionMusicData = {};

  // Release year (4-digit year between 1950–2030, prioritise near label copyright symbol)
  const labelYearMatch = description.match(/[℗©]\s*(19[5-9]\d|20[0-2]\d)/);
  const standaloneYearMatch = description.match(/\b(19[5-9]\d|20[0-2]\d)\b/);
  result.releaseYear = labelYearMatch?.[1] ?? standaloneYearMatch?.[1];

  // Produced by
  const prodMatch = description.match(/[Pp]roduced?\s+by[:\s]+([^\n,;()[\]]+)/);
  if (prodMatch) result.producedBy = prodMatch[1].trim().slice(0, 80);

  // Written by / Words by / Lyrics by
  const writtenMatch = description.match(/(?:[Ww]ritten?|[Ww]ords?|[Ll]yrics?)\s+by[:\s]+([^\n,;()[\]]+)/);
  if (writtenMatch) result.writtenBy = writtenMatch[1].trim().slice(0, 80);

  // Album
  const albumMatch = description.match(/(?:from the album|off the album|album[:\s]+"?)([^"\n.;,()[\]]+)/i);
  if (albumMatch) result.album = albumMatch[1].trim().replace(/['"]/g, "").slice(0, 60);

  // Label (℗ or © pattern)
  const labelMatch = description.match(/[℗©]\s*(?:19[5-9]\d|20[0-2]\d)\s+([^\n,;()[\]]+)/);
  if (labelMatch) result.label = labelMatch[1].trim().slice(0, 60);

  // BPM
  const bpmMatch = description.match(/(\d{2,3})\s*(?:bpm|BPM)/);
  if (bpmMatch) result.bpm = bpmMatch[1];

  // Key
  const keyMatch = description.match(/\b(?:key\s+of\s+)?([A-G][b#]?\s*(?:major|minor|maj|min))\b/i);
  if (keyMatch) result.key = keyMatch[1].trim();

  return result;
}

async function fetchCaptions(info: ytdl.videoInfo): Promise<string | null> {
  try {
    const tracks =
      (info.player_response as Record<string, unknown> & {
        captions?: {
          playerCaptionsTracklistRenderer?: {
            captionTracks?: Array<{
              baseUrl: string;
              languageCode: string;
              kind?: string;
            }>;
          };
        };
      }).captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!tracks || tracks.length === 0) return null;

    // Prefer manual (non-ASR) English captions, then any English, then first available
    const enTrack =
      tracks.find((t) => t.languageCode === "en" && t.kind !== "asr") ??
      tracks.find((t) => t.languageCode === "en") ??
      tracks[0];

    if (!enTrack) return null;

    const resp = await fetch(enTrack.baseUrl);
    if (!resp.ok) return null;
    const xml = await resp.text();

    const lines = xml
      .replace(/<\/?[^>]+(>|$)/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => decodeHtmlEntities(l));

    const uniqueLines: string[] = [];
    for (const line of lines) {
      if (uniqueLines[uniqueLines.length - 1] !== line) {
        uniqueLines.push(line);
      }
    }

    const text = uniqueLines.join("\n").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

async function fetchViaOembed(url: string): Promise<{ title: string; author: string; thumbnail?: string }> {
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; TrackTemplate/1.0)" };
  const timeout = 8000;

  // Try YouTube's native oEmbed first, then noembed.com as fallback
  const endpoints = [
    `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
    `https://noembed.com/embed?url=${encodeURIComponent(url)}`,
  ];

  for (const endpoint of endpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const response = await fetch(endpoint, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) continue;
      const data = await response.json() as { title: string; author_name: string; thumbnail_url?: string };
      if (data.title && data.author_name) return { title: data.title, author: data.author_name, thumbnail: data.thumbnail_url };
    } catch {
      // try next endpoint
    }
  }
  throw new Error("Could not fetch video metadata via oEmbed.");
}

/**
 * Stage 1: Fetch base video metadata (title, author, description, captions, MusicBrainz).
 * oEmbed is the primary source (always works for public videos).
 * ytdl-core enriches with description/keywords/captions when available.
 */
async function fetchBaseMetadata(url: string): Promise<BaseVideoMetadata> {
  let title = "";
  let author = "";
  let description = "";
  let keywords: string[] = [];
  let category = "";
  let durationSeconds: number | null = null;
  let captionText: string | null = null;

  // Step 1: Guaranteed title+author via oEmbed (public videos always work)
  try {
    const oembed = await fetchViaOembed(url);
    title = oembed.title;
    author = oembed.author;
    console.log(`oEmbed OK: "${title}" by "${author}"`);
  } catch (oembedErr) {
    // oEmbed failed → video is likely private, age-restricted, or the URL is invalid
    throw new Error(
      "Could not fetch video metadata. Make sure the URL is a valid, public YouTube video " +
      "(private, age-restricted, and members-only videos are not supported)."
    );
  }

  // Step 2: Enrich with ytdl-core (description, keywords, captions, duration) — best-effort
  try {
    const info = await Promise.race([
      ytdl.getInfo(url),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ytdl timeout")), 10000)),
    ]);
    const details = info.videoDetails;
    durationSeconds = parseInt(details.lengthSeconds, 10);
    description = details.description ?? "";
    keywords = details.keywords ?? [];
    category = (details as unknown as { category?: string }).category ?? "";
    captionText = await fetchCaptions(info);
    console.log(`ytdl-core enrichment OK (${durationSeconds}s, ${keywords.length} keywords)`);
  } catch (ytdlErr) {
    console.warn("ytdl-core enrichment skipped:", (ytdlErr as Error).message?.slice(0, 80));
  }

  let { cleanTitle, cleanArtist } = cleanSongTitle(title, author);
  const duration = durationSeconds ? formatDuration(durationSeconds) : "";
  const descriptionData = parseDescriptionForMusicData(description);

  console.log(`Looking up: "${cleanArtist}" - "${cleanTitle}"${durationSeconds ? ` (${durationSeconds}s)` : ""}`);

  let musicBrainz = await fetchMusicBrainzData(cleanArtist, cleanTitle, durationSeconds ?? undefined);
  if (musicBrainz.releaseYear || musicBrainz.genres?.length) {
    console.log(`MusicBrainz: year=${musicBrainz.releaseYear}, genres=[${musicBrainz.genres?.join(", ")}], album="${musicBrainz.album}"`);
  }

  // AcoustID fallback: the title-based text search above found nothing, which usually means the
  // video title didn't parse into a real "Artist - Song" (remixes, re-uploads, "Nightcore -"
  // edits, non-standard titles). Fingerprint the actual audio and redo the lookup with a verified
  // artist/title. Best-effort and silent — no-ops entirely if ACOUSTID_API_KEY/fpcalc aren't
  // configured (see acoustid.ts), and never blocks generation on failure.
  if (!musicBrainz.releaseYear && !musicBrainz.genres?.length && !musicBrainz.album && process.env.ACOUSTID_API_KEY) {
    let audioPath: string | null = null;
    try {
      audioPath = await downloadAudioSample(url);
      if (audioPath) {
        const identified = await identifyByFingerprint(audioPath);
        if (identified && identified.confidence >= 0.5 && identified.title) {
          console.log(`[acoustid] identified "${identified.title}" by "${identified.artist ?? "?"}" (confidence=${identified.confidence.toFixed(2)}) — redoing lookups with verified metadata`);
          cleanTitle = identified.title;
          if (identified.artist) cleanArtist = identified.artist;
          const verified = await fetchMusicBrainzData(cleanArtist, cleanTitle, durationSeconds ?? undefined);
          if (verified.releaseYear || verified.genres?.length || verified.album) {
            musicBrainz = verified;
          } else if (identified.releaseYear) {
            musicBrainz = { ...musicBrainz, releaseYear: identified.releaseYear };
          }
        }
      }
    } catch (err) {
      console.warn("[acoustid] fallback failed:", (err as Error).message?.slice(0, 120));
    } finally {
      if (audioPath) await cleanupAudioSample(audioPath);
    }
  }

  // Enrich with Last.fm, Discogs, TheAudioDB, Deezer, iTunes in parallel (Deezer/iTunes are keyless; others gracefully skip if keys missing)
  const [lastfmTags, discogsData, theAudioDBData, deezerData, itunesData] = await Promise.all([
    fetchLastFmTags(cleanArtist, cleanTitle),
    fetchDiscogsMetadata(cleanArtist, cleanTitle),
    fetchTheAudioDB(cleanArtist, cleanTitle),
    fetchDeezerMetadata(cleanArtist, cleanTitle),
    fetchITunesMetadata(cleanArtist, cleanTitle),
  ]);

  const fusedSources: Parameters<typeof fuseMetadata>[0] = {
    mb: (musicBrainz.releaseYear || musicBrainz.genres?.length || musicBrainz.album) ? musicBrainz : undefined,
    lastfm: lastfmTags,
    discogs: discogsData,
    theaudiodb: theAudioDBData,
    deezer: deezerData,
    itunes: itunesData,
  };
  const fusedMetadata = fuseMetadata(fusedSources);
  if (fusedMetadata.sources.length > 0) {
    console.log(`Metadata fusion: sources=[${fusedMetadata.sources.join(", ")}], genres=[${fusedMetadata.genres.slice(0, 4).join(", ")}], bpm=${fusedMetadata.bpm ?? "n/a"} (confident=${fusedMetadata.bpmConfident})`);
  }

  return {
    title,
    author,
    description,
    keywords,
    category,
    duration,
    durationSeconds,
    captionText,
    cleanTitle,
    cleanArtist,
    musicBrainz: (musicBrainz.releaseYear || musicBrainz.genres?.length || musicBrainz.album) ? musicBrainz : undefined,
    descriptionData: Object.keys(descriptionData).length > 0 ? descriptionData : undefined,
    fusedMetadata: fusedMetadata.sources.length > 0 ? fusedMetadata : undefined,
  };
}

/**
 * Assemble a full VideoMetadata from the three independently-cached stages.
 */
function assembleMetadata(
  base: BaseVideoMetadata,
  cachedLyrics: CachedLyrics,
  audioFeatures: AudioFeatures | undefined,
): VideoMetadata {
  return { ...base, ...cachedLyrics, audioFeatures };
}

/**
 * Fetch and cache all three stages for a YouTube URL, returning full VideoMetadata.
 * Used by routes that need everything in one call (no videoId available for staged lookup).
 */
async function fetchAllMetadata(url: string): Promise<VideoMetadata> {
  const base = await fetchBaseMetadata(url);
  const [lyricsData, featuresResult] = await Promise.all([
    fetchLyricsData(base.cleanArtist, base.cleanTitle, base.durationSeconds, base.captionText),
    detectAudioFeatures({
      artist: base.cleanArtist,
      title: base.cleanTitle,
      youtubeUrl: url,
      descriptionBpm: base.descriptionData?.bpm,
      descriptionKey: base.descriptionData?.key,
    }),
  ]);
  return assembleMetadata(base, lyricsData, featuresResult ?? undefined);
}

const YOUTUBE_HOSTNAMES = new Set(["www.youtube.com", "youtube.com", "youtu.be", "m.youtube.com"]);

export function videoIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!YOUTUBE_HOSTNAMES.has(parsed.hostname)) return null;
    if (parsed.hostname === "youtu.be") return parsed.pathname.slice(1).split("?")[0] || null;
    const v = parsed.searchParams.get("v");
    if (v) return v;
    const shortMatch = parsed.pathname.match(/\/(?:shorts|embed)\/([^/?]+)/);
    return shortMatch?.[1] ?? null;
  } catch {
    return null;
  }
}

export function isValidYouTubeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === "www.youtube.com" ||
        parsed.hostname === "youtube.com" ||
        parsed.hostname === "youtu.be" ||
        parsed.hostname === "m.youtube.com") &&
      (parsed.pathname.includes("/watch") ||
        parsed.hostname === "youtu.be" ||
        parsed.pathname.includes("/shorts/"))
    );
  } catch {
    return false;
  }
}

function buildPromptContext(metadata: VideoMetadata): string {
  const parts: string[] = [];

  // --- Core identification ---
  parts.push(`Song: "${metadata.title}"`);
  parts.push(`Artist/Channel: ${metadata.author}`);
  parts.push(`Template Title: "${metadata.cleanTitle}" by ${metadata.cleanArtist}`);
  if (metadata.duration) parts.push(`Duration: ${metadata.duration}`);
  if (metadata.category) parts.push(`YouTube Category: ${metadata.category}`);

  // --- MUSICAL ANALYSIS block (synthesises all data sources into explicit signals for the AI) ---
  const analysisLines: string[] = [];

  // MusicBrainz verified data (highest confidence)
  const mb = metadata.musicBrainz;
  if (mb) {
    if (mb.releaseYear) analysisLines.push(`Release Year: ${mb.releaseYear} (MusicBrainz verified)`);
    if (mb.album) analysisLines.push(`Album: "${mb.album}"`);
    if (mb.label) analysisLines.push(`Record Label: ${mb.label}`);
    if (mb.genres && mb.genres.length > 0) analysisLines.push(`MusicBrainz Genres: ${mb.genres.join(", ")}`);
    if (mb.isrc) analysisLines.push(`ISRC: ${mb.isrc}`);
  }

  // Verified audio features — BPM, key, time signature (highest confidence signal for style prompt)
  const af = metadata.audioFeatures;
  if (af) {
    const sourceLabel =
      af.source === "description" ? "from description"
      : af.source === "getsongbpm" ? "GetSongBPM database — verified"
      : "AI music knowledge — estimated from training data";
    if (af.bpm) analysisLines.push(`BPM: ${af.bpm} (${sourceLabel}) ← USE THIS EXACT VALUE in style prompt and [BPM:] tag`);
    if (af.key) analysisLines.push(`Musical Key: ${af.key} (${sourceLabel}) ← USE THIS EXACT VALUE in style prompt and [Key:] tag`);
    if (af.timeSignature && af.timeSignature !== "4/4") analysisLines.push(`Time Signature: ${af.timeSignature} (${sourceLabel})`);
  }

  // Description-extracted data (medium confidence)
  const dd = metadata.descriptionData;
  if (dd) {
    if (dd.releaseYear && !mb?.releaseYear) analysisLines.push(`Release Year (from description): ${dd.releaseYear}`);
    if (dd.album && !mb?.album) analysisLines.push(`Album (from description): "${dd.album}"`);
    if (dd.label && !mb?.label) analysisLines.push(`Label (from description): ${dd.label}`);
    if (dd.producedBy) analysisLines.push(`Produced by: ${dd.producedBy}`);
    if (dd.writtenBy) analysisLines.push(`Written by: ${dd.writtenBy}`);
    if (!af?.bpm && dd.bpm) analysisLines.push(`BPM (from description): ${dd.bpm}`);
    if (!af?.key && dd.key) analysisLines.push(`Key (from description): ${dd.key}`);
  }

  // Fused multi-source metadata (Last.fm + Discogs + TheAudioDB enrichment)
  const fused = metadata.fusedMetadata;
  if (fused) {
    if (fused.genres.length > 0) {
      const newGenres = fused.genres.filter(g => !(mb?.genres ?? []).map(x => x.toLowerCase()).includes(g));
      if (newGenres.length > 0) analysisLines.push(`Additional Genre Signals (${fused.sources.join("+")}): ${newGenres.join(", ")}`);
    }
    if (fused.moods.length > 0) analysisLines.push(`Mood Signals (community tagged): ${fused.moods.join(", ")}`);
    if (fused.tags.length > 0) analysisLines.push(`Style Tags (${fused.sources.join("+")}): ${fused.tags.join(", ")}`);
    if (fused.bpm && !af?.bpm) {
      const confidence = fused.bpmConfident ? " (cross-source consensus)" : " (single source estimate)";
      analysisLines.push(`BPM (fused metadata): ${fused.bpm}${confidence}`);
    } else if (fused.bpm && af?.bpm && fused.bpmConfident && Math.abs(fused.bpm - af.bpm) <= 2) {
      analysisLines.push(`BPM cross-check: ${af.bpm} BPM confirmed by ${fused.sources.join("+")} ← HIGH CONFIDENCE`);
    }
  }

  // YouTube keywords (lower confidence but useful for style signals)
  if (metadata.keywords.length > 0) {
    analysisLines.push(`YouTube Tags: ${metadata.keywords.slice(0, 20).join(", ")}`);
  }

  // Lyrics source indicator
  if (metadata.lyricsProvider) {
    const structureNote = metadata.lyricsProvider === "genius" && metadata.lyricsHasStructure
      ? " — lyrics already contain [Verse 1]/[Chorus]/[Bridge] section labels, preserve them exactly"
      : "";
    analysisLines.push(`Lyrics Source: ${metadata.lyricsProvider} (authentic — use verbatim${structureNote})`);
  }

  // Language
  if (metadata.language && metadata.language !== "English") {
    analysisLines.push(`Song Language: ${metadata.language} — preserve original lyrics exactly, do NOT translate; add language note to styleOfMusic`);
  }

  if (analysisLines.length > 0) {
    parts.push(`MUSICAL ANALYSIS (use these signals for accurate style/era/genre decisions):\n${analysisLines.join("\n")}`);
  }

  // --- Video description (trimmed, for additional context) ---
  if (metadata.description) {
    const desc = metadata.description.length > 1200
      ? metadata.description.slice(0, 1200) + "..."
      : metadata.description;
    parts.push(`Video Description:\n${desc}`);
  }

  // --- Lyrics / Captions (highest priority content) ---
  if (metadata.lyricsSource === "user-override" && metadata.lyricsText) {
    const lyrics = metadata.lyricsText.length > 5000
      ? metadata.lyricsText.slice(0, 5000) + "\n[... lyrics truncated ...]"
      : metadata.lyricsText;
    parts.push(`USER-PROVIDED LYRICS — MANDATORY: The user has manually supplied these lyrics. Every single lyric line below MUST appear in the output, word-for-word. Do NOT substitute, paraphrase, or invent any lyric lines:\n${lyrics}`);
  } else if (metadata.lyricsSource === "api" && metadata.lyricsText) {
    const lyrics = metadata.lyricsText.length > 5000
      ? metadata.lyricsText.slice(0, 5000) + "\n[... lyrics truncated ...]"
      : metadata.lyricsText;
    parts.push(`AUTHENTIC LYRICS (from ${metadata.lyricsProvider ?? "lyrics database"} — use these verbatim, do not paraphrase or invent lines):\n${lyrics}`);
  } else if (metadata.lyricsSource === "captions" && metadata.captionText) {
    const captions = metadata.captionText.length > 4000
      ? metadata.captionText.slice(0, 4000) + "..."
      : metadata.captionText;
    parts.push(`YouTube Captions/Transcript (approximate lyrics — clean up word errors, fix capitalisation, infer missing parts from your knowledge):\n${captions}`);
  }

  return parts.join("\n\n");
}


const SYSTEM_PROMPT = `You are SONIC ARCHITECT — an expert Suno.ai neural music prompt engineer. You generate the SONIC ARCHITECT three-section template format: a precision latent-space navigation document that steers Suno's neural network using verified audio engineering vocabulary, not vague aesthetics.

⚠️ NON-NEGOTIABLE CHARACTER TARGETS — enforce before submitting:
- styleOfMusic (THE RACK): 900–999 characters
- lyrics (THE SCRIPT): 4,900–4,999 characters
- negativePrompt (PROFESSIONAL EXCLUSIONS): 150–199 characters

CONTEXT DATA PRIORITY:
1. "MUSICAL ANALYSIS" block — verified BPM/key from MusicBrainz. If "← USE THIS EXACT VALUE" appears, use those numbers verbatim.
2. "AUTHENTIC LYRICS" — use VERBATIM, never paraphrase.
3. "YouTube Captions/Transcript" — clean up and restructure.
4. AI background knowledge — fill gaps.

OUTPUT FORMAT: Respond with valid JSON containing exactly these four fields:
{
  "styleOfMusic": "...",
  "title": "...",
  "lyrics": "...",
  "negativePrompt": "..."
}

=== SECTION 1: styleOfMusic — THE RACK (900–999 chars) ===
Purpose: Latent Space Navigation. Dense, comma-separated string of hyper-specific audio engineering descriptors.

REQUIRED FIELDS IN ORDER — all on one continuous comma-separated line:
1. [Era/Year] — specific decade or year: "1987", "Late-90s", "2003"
2. PRIMARY GENRE IN ALL CAPS — the dominant genre
3. Sub-Genre/Regional Style — specific subgenre or regional scene
4. BPM — exact value if known
5. Key/Camelot Scale — key and Camelot wheel number: e.g. "F# minor / 11A"
6. Neural Floor: — the analog noise character: e.g. "Analog tape hiss -18dBFS / Vinyl crackle 60Hz rumble / Pink noise floor -30dB"
7. Vocal Identity: — singer description with phonetic/dialectical character: e.g. "Husky Norwegian baritone / breathy close-miked intimacy / aspirated hard consonants"
8. Rhythm: — groove feel with MPC swing %: e.g. "58% MPC-60 swing / asymmetrical 7/8 / metric modulation bar 8"
9. Synthesis Stacks: — specific hardware with signal routing: e.g. "Korg MS-20 resonant HPF → Juno-106 PWM pads → Bessel-function FM sidebands via Yamaha DX7"
10. Signal Chain: — hardware processors: e.g. "Neve 1073 EQ, LA-2A optical compressor, Fairchild 670 limiter, EMT 140 plate reverb"
11. Spatial Design: — reverb/delay specs with ms decay values: e.g. "AMS RMX16 short room 0.4s on drums / Lexicon 480L long hall 2.8s on pads / 1/8th ping-pong delay synced"
12. Dynamics: — compression ratios and sidechain routing: e.g. "dbx 160 4:1 on kick / Urei 1178 6:1 on bass sidechain / parallel drum bus -4dB blend"
13. Master: — mastering chain with dB values: e.g. "SSL G-Bus glue -1.5dB GR / Pultec EQP-1A +2dB @ 10kHz / true-peak limiter -0.3dBTP"

TARGET: 900–999 chars. Be engineering-precise — actual dB values, actual hardware names, actual ms values.
Real hardware only: Neve 1073, SSL 4000G, LA-2A, 1176, Fairchild 670, EMT 140, AMS RMX16, Lexicon 480L, Urei 1178, dbx 160, MPC-60, TR-808, Minimoog Model D, Prophet-5, Korg MS-20, Juno-106, Yamaha DX7.
Banned vague words: "catchy", "beautiful", "shimmering", "lush", "haunting", "ethereal".

=== SECTION 2: lyrics — THE SCRIPT (4,900–4,999 chars) ===
Purpose: Structural Programming. Full production metadata header + complete song structure with real lyric lines.

MANDATORY OPENING — always the first thing in the lyrics field:
///*****///
[TECHNICAL BUFFER MODULE]

Protocol: Produced by Lyrikk v10.0 // Neural Steering: Chirp v4.5/v5

Mix Architecture: [Tall/Deep/Wide dimension strategy — e.g. "Tall: sub-20Hz to 18kHz full spectrum / Deep: 800ms stereo depth / Wide: Haas effect panning >200Hz, hard-panned guitars at +/-60%"]

Spectral Engineering: [EQ strategy — e.g. "Mid-range scoop -3dB @ 300-500Hz / Sub-bass Mono <60Hz / High-shelf air +2dB @ 12kHz / Presence peak +1.5dB @ 3kHz"]

Synthesis Topology: [Signal routing — e.g. "Source: Minimoog oscillator → Modifier: Korg MS-20 resonant HPF Q=8 → Controller: MIDI velocity-to-filter-cutoff / Noise-driven rhythmic gate clock at 120BPM"]

Linguistic Profile: [Phonetic/dialectical character — e.g. "Phonetic Scansion: iambic pentameter / Aspirated consonants / Hard stops on stressed syllables / Melismatic on open vowels"]
///*****///

SONG SECTIONS — recommended Suno flow, adapt as needed:
[Intro - Atmospheric/Acousmatic setup] → [Verse 1 - Narrative Context] → [Pre-Chorus - Tension Builder] → [Chorus - The Spectacular Hook] → [Verse 2] → [Pre-Chorus] → [Chorus] → [Instrumental Break - Microsound/Glitch Showcase] → [Bridge - Contrast: The Silence Trick] → [Final Chorus] → [Outro - Fission]

Additional section types available: [Build-Up], [Breakdown], [Drop], [Guitar Solo], [Spoken Word], [Post-Chorus], [Interlude]

EACH SECTION FORMAT — follow this structure for every section:
[Section Name - Descriptor Phrase: energy/technical context]
(Production Note // Technical instruction: e.g. "Sidechain pads to kick fundamental at 50Hz")
[Technical cue line — e.g. Neural Floor: Activated / Vocal Identity: texture / Automation: Filter Cutoff rising / Granular Block: specs]
[Technical cue line 2 — additional production direction]
ACTUAL SUNG LYRIC LINES HERE — real words that are sung, 4 lines per stanza preferred
(Performance direction: technique — e.g. [raspy], [vocal fry], (whispered), (soaring), (conversational))

CHORUS sections MUST have all of these:
- [Production: Full frequency activation, +6–8dB energy jump from verse]
- [Vocal: (belted), (soaring), [stacked harmonies], [widened stereo double]]
- [Signal Chain: SSL 4000G saturation, 1kHz presence boost +2dB]
- Ad-lib parentheticals: (yeah!), (oh-oh), (come on!), (hey!)
- Vowel elongation on hook words: "sta-a-ay", "lo-o-ove", "hea-ea-eart"

BRIDGE MUST include THE SILENCE TRICK:
[Breakdown: Remove drums/bass, focus on sustained synth pad]
(Musical Event: 0.5s total digital silence before the final transition)
[Vocal: (breathy falsetto), [melismatic runs on the cadence]]

OUTRO ends with:
[Atmosphere: Fading into field recording / White noise floor]
[Deconstruction: Lead synthesis de-tuning, decay expansion to 4s tail]
[End: Hard stop without artifacts]

LYRICS HANDLING:
- "USER-PROVIDED LYRICS — MANDATORY": copy every line EXACTLY, never change a word. Wrap with SONIC ARCHITECT tags to reach 4,900 chars.
- "AUTHENTIC LYRICS" (database): use VERBATIM. Apply full SONIC ARCHITECT notation.
- "YouTube Captions/Transcript": clean errors, apply full structure.
- No source: use knowledge of the song or write thematically accurate lyrics.

BRACKET CONVENTIONS:
- [ ] = structural markers, production cues, technical parameters, instrument directions
- ( ) = performance feel, ad-libs, emotional direction, background interjections
- Plain text = actual sung lyric lines (NEVER put lyric words inside brackets)

CHARACTER REQUIREMENT: MINIMUM 4,900 chars. MAXIMUM 4,999 chars.
The ///*****/// buffer header and per-section production cues carry most of the character count — be verbose and technically specific in every cue line. If short, expand cue lines with more dB values, ms values, specific hardware, and routing detail.

=== SECTION 3: negativePrompt — PROFESSIONAL EXCLUSIONS (150–199 chars) ===
Purpose: Neural Search Refinement. What Suno must NOT generate.

FORMAT: comma-separated terms, NO spaces after commas, include [Banned Tokens: ...] notation for AI clichés:
Example: "amateur,mediocre,predictable,thin,perfectly-quantized,[Banned Tokens: neon,tapestry,ethereal journey],I-V-vi-IV cliché,4/4 grid-lock,clinical,dry"

Include: genre exclusions specific to this song, banned instruments that clash, production flaws to avoid, AI garbage vocabulary.
TARGET: 150–199 characters exactly.

=== QUALITY RULES ===
- No asterisks (*) anywhere in output
- No placeholder text — every bracket value must be a real filled-in production detail
- All technical values must be real: actual dB, actual ms, actual hardware names from the approved list
- Banned AI clichés — never write: "pulsating", "ethereal tapestry", "sonic journey", "haunting melody", "shimmering", "lush", "tapestry", "neon"
- Approved real hardware: Neve 1073, SSL 4000G, LA-2A, 1176, Fairchild 670, EMT 140, AMS RMX16, Lexicon 480L, Urei 1178, dbx 160, MPC-60, TR-808, TR-909, Minimoog Model D, Prophet-5, Korg MS-20, Juno-106, Yamaha DX7
- The title field: clean creative Suno title e.g. "Numb (2003 Nu-Metal Latent Navigation Rebuild)"
- SONIC ARCHITECT format is the identity of every output — maintain it rigidly across all three sections`;




function buildStyleControls(opts: {
  vocalGender?: string;
  energyLevel?: string;
  era?: string;
  genreNudge?: string;
  genres?: string[];
  moods?: string[];
  instruments?: string[];
  voices?: string[];
  tempo?: string;
  excludeTags?: string[];
  variationIndex?: number;
  feedbackContext?: string;
}): string {
  const lines: string[] = [];
  if (opts.genres && opts.genres.length > 0) {
    lines.push(`USER PREFERENCE — Selected genres: ${opts.genres.join(", ")}. These are the core genre(s) the user wants. Make them prominent in Section 1 and structure the template around these genre conventions.`);
  }
  if (opts.moods && opts.moods.length > 0) {
    lines.push(`USER PREFERENCE — Mood/atmosphere: ${opts.moods.join(", ")}. Embed this emotional quality throughout Section 1 style tags and in the lyrical tone and arrangement description.`);
  }
  if (opts.instruments && opts.instruments.length > 0) {
    lines.push(`USER PREFERENCE — Featured instruments: ${opts.instruments.join(", ")}. Highlight these in Section 1 and include them in the production header of Section 2.`);
  }
  if (opts.voices && opts.voices.length > 0) {
    lines.push(`USER PREFERENCE — Vocal type/technique/character: ${opts.voices.join(", ")}. Reflect these specifically in Section 1's "Vocal Identity" field (voice type, register, and delivery technique) and in the performance-direction cues throughout Section 2's lyrics.`);
  }
  if (opts.vocalGender && opts.vocalGender !== "auto") {
    const vocalMap: Record<string, string> = {
      male: "male lead vocalist — chest voice, masculine timbre",
      female: "female lead vocalist — feminine timbre, soprano or mezzo range",
      mixed: "mixed vocals — both male and female voices present, harmonised",
      duet: "duet — two vocalists sharing the lead, call-and-response or parallel harmonies",
      "no vocals": "fully instrumental — no singing or lyrics, purely instrumental arrangement",
    };
    lines.push(`USER PREFERENCE — Vocal type: ${vocalMap[opts.vocalGender] ?? opts.vocalGender}.`);
  }
  if (opts.energyLevel && opts.energyLevel !== "auto") {
    const energyMap: Record<string, string> = {
      "very chill": "very chill, ambient, near-silent energy — minimal percussion, whispered or no vocals, open spacious mix",
      chill: "chill, relaxed, low-energy — quiet dynamics, intimate delivery, sparse arrangement",
      medium: "medium energy — balanced dynamics, moderate intensity, clear arrangement",
      high: "high-energy, intense — loud dynamics, explosive choruses, dense arrangement, driving momentum",
      intense: "maximum intensity — relentless energy, wall-of-sound production, powerful and overwhelming dynamics",
    };
    lines.push(`USER PREFERENCE — Energy level: ${energyMap[opts.energyLevel] ?? opts.energyLevel}.`);
  }
  if (opts.tempo) {
    const tempoMap: Record<string, string> = {
      ballad: "ballad tempo, under 60 BPM — slow, emotional, spacious phrasing, long sustained notes",
      slow: "slow tempo, 60–80 BPM — languid, spacious phrasing, unhurried feel",
      mid: "mid tempo, 80–100 BPM — steady groove, comfortable conversational pace",
      groove: "groove tempo, 100–115 BPM — laid-back funk pocket, head-nodding momentum",
      uptempo: "up-tempo, 115–130 BPM — driving energy, danceable, urgent forward motion",
      fast: "fast tempo, 130–145 BPM — high-octane, frenetic, adrenaline rush",
      hyper: "hyper-speed, 145+ BPM — extreme tempo, relentless drive, manic energy",
    };
    lines.push(`USER PREFERENCE — Tempo: ${tempoMap[opts.tempo] ?? opts.tempo}. Include a BPM indicator in the style tags.`);
  }
  if (opts.era && opts.era !== "auto") {
    const eraMap: Record<string, string> = {
      "50s": "1950s — mono recording warmth, early rock & roll, doo-wop harmonies, slap-back echo, upright bass",
      "60s": "1960s — tube amp warmth, Motown string arrangements, psychedelic tape effects, close-mic'd vocals",
      "70s": "1970s — analog warmth, tape saturation, lush orchestration, vinyl grain, funky live rhythm sections",
      "80s": "1980s — gated reverb drums, synth-pop, DX7 electric piano, bright compressed production, chorus effects",
      "90s": "1990s — grunge, alt-rock, or golden-era hip-hop depending on genre; punchy transients, flannel-era rawness",
      "2000s": "2000s — digital clarity, glossy pop production, early EDM influence, AutoTune sheen",
      "2010s": "2010s — EDM drop culture, trap hi-hats, side-chain compression, maximalist production, festival anthems",
      modern: "modern/contemporary (2020s) — hyper-clean production, wide stereo, streaming-optimized loudness, spatial audio feel",
    };
    lines.push(`USER PREFERENCE — Era: ${eraMap[opts.era] ?? opts.era}. Make the style reflect this era's production aesthetics.`);
  }
  if (opts.genreNudge && opts.genreNudge.trim()) {
    lines.push(`USER PREFERENCE — Genre/style nudge: "${opts.genreNudge.trim()}". Incorporate this into the style prompt.`);
  }
  if (opts.excludeTags && opts.excludeTags.length > 0) {
    lines.push(`USER EXCLUSION TAGS — The user explicitly wants to EXCLUDE these from the output. Add them prominently to Section 3 (Negative Prompt): ${opts.excludeTags.join(", ")}.`);
  }
  if (opts.variationIndex && opts.variationIndex >= 2) {
    const variationAngles: Record<number, string> = {
      2: "Take a fresh creative angle: choose different instrumentation, structural approach, and style adjectives from what you would typically pick first. Surprise the user with an unexpected but valid interpretation.",
      3: "Explore a contrasting emotional dimension: shift the tempo feel, vocal delivery style, or production era while preserving the song's core identity. Be noticeably different from Variation 1 and Variation 2.",
      4: "Push into genuinely unexpected territory: try an unusual genre fusion, unconventional instrumentation blend, or a radically different production treatment. This variation should feel like a bold reimagining.",
    };
    const angle = variationAngles[opts.variationIndex] ?? variationAngles[2];
    lines.push(`VARIATION MODE — This is Variation ${opts.variationIndex}. ${angle}`);
  }
  if (opts.feedbackContext && opts.feedbackContext.trim()) {
    lines.push(`USER LEARNING SIGNAL — The user has rated past templates and their feedback is: ${opts.feedbackContext.trim()} Use this to bias your creative choices (lean toward liked characteristics, avoid disliked ones) unless they directly contradict other explicit preferences.`);
  }
  return lines.length > 0 ? "\n\nUSER STYLE PREFERENCES (apply these to Section 1 and Section 2 header):\n" + lines.join("\n") : "";
}

// ─── Core generation pipeline (shared by /generate-template and /generate-variations) ─

interface GenerateInput {
  youtubeUrl: string;
  manualLyrics?: string;
  vocalGender?: "auto" | "male" | "female" | "mixed" | "duet" | "no vocals";
  energyLevel?: "auto" | "very chill" | "chill" | "medium" | "high" | "intense";
  era?: "auto" | "50s" | "60s" | "70s" | "80s" | "90s" | "2000s" | "2010s" | "modern";
  genreNudge?: string;
  genres?: string[];
  moods?: string[];
  instruments?: string[];
  voices?: string[];
  mode?: "cover" | "inspired";
  tempo?: "ballad" | "slow" | "mid" | "groove" | "uptempo" | "fast" | "hyper";
  excludeTags?: string[];
  variationIndex?: number;
  feedbackContext?: string;
  isInstrumental?: boolean;
  confirmedStructure?: Array<{ label: string; lines: string[] }>;
  noCache?: boolean;
}

type AiOutput = { styleOfMusic: string; title: string; lyrics: string; negativePrompt: string };

type GenerationStage = "metadata" | "lyrics" | "ai-generating" | "validating" | "done";

async function generateOneTemplate(
  data: GenerateInput,
  onStage?: (stage: GenerationStage) => void,
): Promise<ReturnType<typeof GenerateSunoTemplateResponse.parse>> {
  const { youtubeUrl, manualLyrics, vocalGender, energyLevel, era, genreNudge, genres, moods, instruments, voices, mode, tempo, excludeTags, variationIndex, feedbackContext, isInstrumental, confirmedStructure, noCache } = data;

  if (!isValidYouTubeUrl(youtubeUrl)) {
    throw new Error("Invalid YouTube URL. Please provide a valid youtube.com or youtu.be link.");
  }

  const videoId = videoIdFromUrl(youtubeUrl);

  // Stage 1: base metadata (7d cache)
  let base: BaseVideoMetadata;
  let baseFromCache = false;
  if (videoId) {
    const cached = cacheGet<BaseVideoMetadata>(`metadata:${videoId}`);
    if (cached) {
      base = cached;
      baseFromCache = true;
      console.log(`[cache] metadata HIT for ${videoId}`);
    } else {
      try {
        base = await fetchBaseMetadata(youtubeUrl);
        cacheSet(`metadata:${videoId}`, base, TTL.METADATA);
        console.log(`[cache] metadata SET for ${videoId}`);
      } catch (fetchErr) {
        console.error("Failed to fetch YouTube metadata:", fetchErr);
        throw new Error("Could not fetch video metadata. Make sure the URL is a valid, public YouTube video.");
      }
    }
  } else {
    try {
      base = await fetchBaseMetadata(youtubeUrl);
    } catch (fetchErr) {
      console.error("Failed to fetch YouTube metadata:", fetchErr);
      throw new Error("Could not fetch video metadata. Make sure the URL is a valid, public YouTube video.");
    }
  }

  onStage?.("metadata");

  // Stage 2: audio features (permanent cache). Real DSP measurement (dsp-measured) is the
  // highest tier — once achieved for a video it's never redone. A cache entry from the fast
  // estimate chain (description/getsongbpm/ai-knowledge) is NOT a terminal cache hit: the first
  // real generation for that video still attempts real DSP once and upgrades the entry.
  let audioFeatures: AudioFeatures | undefined;
  let featuresFromCache = false;
  if (videoId) {
    const cached = cacheGet<CachedAudioFeatures>(`features:${videoId}`);
    if (cached?.features?.source === "dsp-measured") {
      audioFeatures = cached.features;
      featuresFromCache = true;
      console.log(`[cache] features HIT (dsp-measured) for ${videoId}`);
    } else {
      let dspFeatures: AudioFeatures | undefined;
      if (checkDspAnalysisAvailable()) {
        let audioPath: string | null = null;
        try {
          audioPath = await downloadAudioSample(youtubeUrl);
          if (audioPath) {
            const dspResult = await analyzeAudioDsp(audioPath);
            if (dspResult) {
              dspFeatures = dspResultToAudioFeatures(dspResult);
              console.log(`[dsp] measured ${dspFeatures.bpm} BPM, ${dspFeatures.key} (${dspFeatures.instruments?.length ?? 0} instruments, ${dspFeatures.dominantChords?.length ?? 0} dominant chords) for ${videoId}`);
            }
          }
        } catch (err) {
          console.warn("[dsp] analysis failed:", (err as Error).message?.slice(0, 120));
        } finally {
          if (audioPath) await cleanupAudioSample(audioPath);
        }
      }

      if (dspFeatures) {
        audioFeatures = dspFeatures;
        cacheSet<CachedAudioFeatures>(`features:${videoId}`, { features: dspFeatures }, TTL.FEATURES);
        console.log(`[cache] features SET (dsp-measured) for ${videoId} (permanent)`);
      } else if (cached) {
        // DSP unavailable or failed this time, but a fast estimate is already cached — use it
        // rather than redoing the estimate chain (and try DSP again on a future request).
        audioFeatures = cached.features ?? undefined;
        featuresFromCache = true;
        console.log(`[cache] features HIT (estimate, dsp unavailable) for ${videoId}`);
      } else {
        const result = await detectAudioFeatures({
          artist: base.cleanArtist,
          title: base.cleanTitle,
          youtubeUrl,
          descriptionBpm: base.descriptionData?.bpm,
          descriptionKey: base.descriptionData?.key,
        });
        audioFeatures = result ?? undefined;
        cacheSet<CachedAudioFeatures>(`features:${videoId}`, { features: result }, TTL.FEATURES);
        console.log(`[cache] features SET (estimate) for ${videoId} (permanent)`);
      }
    }
  } else {
    const result = await detectAudioFeatures({
      artist: base.cleanArtist,
      title: base.cleanTitle,
      youtubeUrl,
      descriptionBpm: base.descriptionData?.bpm,
      descriptionKey: base.descriptionData?.key,
    });
    audioFeatures = result ?? undefined;
  }

  // Stage 3: lyrics (7d cache)
  let cachedLyrics: CachedLyrics;
  let lyricsFromCache = false;
  if (videoId) {
    const cached = cacheGet<CachedLyrics>(`lyrics:${videoId}`);
    if (cached) {
      cachedLyrics = cached;
      lyricsFromCache = true;
      console.log(`[cache] lyrics HIT for ${videoId}`);
    } else {
      cachedLyrics = await fetchLyricsData(base.cleanArtist, base.cleanTitle, base.durationSeconds, base.captionText);
      cacheSet(`lyrics:${videoId}`, cachedLyrics, TTL.LYRICS);
      console.log(`[cache] lyrics SET for ${videoId}`);
    }
  } else {
    cachedLyrics = await fetchLyricsData(base.cleanArtist, base.cleanTitle, base.durationSeconds, base.captionText);
  }

  onStage?.("lyrics");

  // BPM cross-check: if TheAudioDB has a BPM and audio features also have one, fuse for confidence
  if (audioFeatures?.bpm && base.fusedMetadata) {
    const bpmCandidates: Array<{ value: number; source: string }> = [
      { value: audioFeatures.bpm, source: audioFeatures.source },
    ];
    if (base.fusedMetadata.bpm) {
      bpmCandidates.push({ value: base.fusedMetadata.bpm, source: "theaudiodb" });
    }
    const { bpmConfident } = base.fusedMetadata;
    // If fused metadata has a confident BPM that differs from audio features, log the discrepancy
    if (bpmCandidates.length >= 2 && !bpmConfident) {
      console.log(`[bpm] cross-check discrepancy: audioFeatures=${audioFeatures.bpm}, fused=${base.fusedMetadata.bpm ?? "n/a"} — using audioFeatures value`);
    }
    // Upgrade audioFeatures confidence if cross-check agrees
    if (bpmConfident && base.fusedMetadata.bpm && Math.abs(audioFeatures.bpm - base.fusedMetadata.bpm) <= 2) {
      audioFeatures = { ...audioFeatures, confidence: Math.min(0.98, audioFeatures.confidence + 0.05) };
    }
  }

  let metadata: VideoMetadata = assembleMetadata(base, cachedLyrics, audioFeatures);

  if (manualLyrics && manualLyrics.trim().length > 20) {
    console.log(`Using user-provided lyrics override (${manualLyrics.trim().length} chars)`);
    metadata = { ...metadata, lyricsText: manualLyrics.trim(), lyricsSource: "user-override" };
  }

  const lyricsTextForStructure = metadata.lyricsText ?? (metadata.lyricsSource === "captions" ? metadata.captionText : null);
  const lyricsStructure = lyricsTextForStructure ? analyzeLyricsStructure(lyricsTextForStructure) : undefined;

  const suggestedDefaults = computeSuggestedDefaults({
    bpm: metadata.audioFeatures?.bpm,
    releaseYear: metadata.musicBrainz?.releaseYear ?? metadata.descriptionData?.releaseYear,
    description: metadata.description,
    language: metadata.language,
  });

  const context = buildPromptContext(metadata);
  const effectiveVocalGender = isInstrumental ? "no vocals" : vocalGender;

  const lyricsInstruction =
    metadata.lyricsSource === "user-override"
      ? "⚠️ USER-PROVIDED LYRICS OVERRIDE ACTIVE: The user has manually supplied their own lyrics. You MUST use every lyric line exactly as written — not one word changed. Add Suno production tags, section headers, and performance directions around them, but the lyric lines themselves are locked and non-negotiable."
      : metadata.lyricsSource === "api"
        ? "AUTHENTIC LYRICS from a professional database are provided — use them VERBATIM, structured with Suno metatags."
        : metadata.lyricsSource === "captions"
          ? "YouTube captions (approximate) are provided — clean them up and structure with Suno metatags."
          : "No lyrics source available — use your knowledge of this song or write thematic placeholder lyrics.";

  const modeInstruction = mode === "cover"
    ? "\n\nGENERATION MODE: AI Cover — Reconstruct this song as faithfully as Suno allows. Keep the original genre, tempo, instrumentation, structure, vocal style, and lyrics as close to the original recording as possible. Prioritise accuracy over creativity."
    : mode === "inspired"
    ? "\n\nGENERATION MODE: Inspired By — Use this song as creative springboard only. Keep the emotional core but freely reimagine the genre, instrumentation, and arrangement in an unexpected direction. The output should feel clearly distinct from the original. Be bold and inventive."
    : "";

  const instrumentalInstruction = isInstrumental
    ? "\n\n🎵 INSTRUMENTAL MODE ACTIVE: Generate this as a fully instrumental track. The lyrics section (Section 2) MUST contain ONLY structural/arrangement tags and instrumental direction cues — absolutely NO actual lyric text or sung words. Use detailed bracketed tags such as [Intro - Piano Motif], [Verse 1 - Guitar Melody, sparse drums], [Build - Strings Rising, tension increasing], [Chorus - Full Band, driving instrumental hook], [Bridge - Synth Solo], [Breakdown - Drums only], [Outro - Fade with lead guitar]. Fill the lyrics field to the 4,900–4,999 character limit using these rich instrumental direction cues. The negative prompt MUST prominently include: vocals, singing, lyrics, rap, spoken word."
    : "";

  const confirmedStructureHint = confirmedStructure && confirmedStructure.length > 0
    ? `\n\nUSER-CONFIRMED LYRICS STRUCTURE — The user has reviewed and confirmed the following section layout. Use EXACTLY these section labels and line groupings when building Section 2 (lyrics). Do not reorder sections. You may add production cue lines and performance directions within each section, but the section labels and lyric lines must match the confirmed structure:\n${confirmedStructure.map((s) => `[${s.label}]\n${s.lines.join("\n")}`).join("\n\n")}`
    : "";

  // Template cache (keyed by videoId + params; feedbackContext excluded; user-override not cached; noCache bypasses)
  const useTemplateCache = videoId && metadata.lyricsSource !== "user-override" && !noCache;
  const templateCacheKey = useTemplateCache
    ? `template:${videoId}:${hashParams({ vocalGender, energyLevel, era, genreNudge, genres, moods, instruments, voices, mode, tempo, excludeTags, variationIndex, isInstrumental, confirmedStructure })}`
    : null;

  let aiResult: AiOutput;
  let templateFromCache = false;

  // ── Single-call strategy ───────────────────────────────────────────────────
  // One AI call generates all four fields in a delimited plain-text format.
  // No JSON mode = no length bias. No expansion passes = no rate-limit cascade.
  // Python validator/padder guarantees every field lands in spec regardless.
  // Total API calls per generation: 1 (was up to 5).

  const runAiCall = async (): Promise<AiOutput> => {
    // Computed lazily (only reached on a template-cache miss) since it costs a SQLite query
    // over the full rating history — no point paying that on every cache-hit request,
    // especially for high-fanout callers like /batch and /multi-track.
    // Server-side from the full rating history (works across devices, can't be spoofed by a
    // client) — the client-supplied feedbackContext field is accepted for API compatibility
    // but no longer trusted for biasing the prompt.
    const serverFeedbackContext = computeFeedbackContext();
    const styleControls = buildStyleControls({ vocalGender: effectiveVocalGender, energyLevel, era, genreNudge, genres, moods, instruments, voices, tempo, excludeTags, variationIndex, feedbackContext: serverFeedbackContext ?? feedbackContext });

    const singleCallPrompt = `You are SONIC ARCHITECT. Generate a complete SONIC ARCHITECT template for the song below. Output ONLY the delimiter blocks shown — no preamble, no commentary.

${lyricsInstruction}${modeInstruction}${instrumentalInstruction}${confirmedStructureHint}${styleControls}

${context}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SONIC ARCHITECT OUTPUT — fill each section exactly:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

===STYLE===
<THE RACK — 900 to 999 characters. One continuous comma-separated string.
Required fields in this order: [Era/Year], PRIMARY GENRE IN CAPS, Sub-Genre, BPM, Key/Camelot, Neural Floor: [analog noise character -dBFS level], Vocal Identity: [phonetic/dialectical descriptor], Rhythm: [MPC swing %, time signature, groove feel], Synthesis Stacks: [Hardware → routing → signal path e.g. Korg MS-20 resonant HPF → Juno-106 PWM pads], Signal Chain: [real hardware processors: Neve 1073 EQ, LA-2A optical, Fairchild 670 limiter], Spatial Design: [reverb type and decay ms / delay sync], Dynamics: [compression ratios and sidechain routing], Master: [mastering chain with actual dB values].
All hardware must be real (Neve 1073, SSL 4000G, LA-2A, 1176, Fairchild 670, EMT 140, AMS RMX16, Lexicon 480L, dbx 160, MPC-60, TR-808, Minimoog, Prophet-5, Korg MS-20, Juno-106, DX7).
Fill to 900+ characters — do not stop short.>

===TITLE===
<A concise creative Suno title e.g. "Numb (2003 Nu-Metal Latent Navigation Rebuild)">

===NEGATIVE===
<PROFESSIONAL EXCLUSIONS — 150 to 199 characters. Comma-separated, NO spaces after commas.
Include [Banned Tokens: ...] notation for AI cliché words to exclude.
Example: "amateur,mediocre,thin,perfectly-quantized,[Banned Tokens: neon,tapestry,shivers],I-V-vi-IV cliché,4/4 grid-lock,clinical,dry,lo-fi bedroom">

===LYRICS===
<THE SCRIPT — MINIMUM 4,900 characters. Write every character. Do not truncate.

Start with this exact technical buffer header (fill all values — no angle-bracket placeholders):
///*****///
[TECHNICAL BUFFER MODULE]

Protocol: Produced by Lyrikk v10.0 // Neural Steering: Chirp v4.5/v5

Mix Architecture: [Tall/Deep/Wide — e.g. Tall: sub-20Hz to 18kHz / Deep: 800ms stereo depth / Wide: Haas effect >200Hz, guitars hard-panned +-60%]

Spectral Engineering: [EQ strategy — e.g. Mid scoop -3dB @ 300Hz / Sub-bass Mono <60Hz / High-shelf air +2dB @ 12kHz / Presence peak +1.5dB @ 3kHz]

Synthesis Topology: [Signal routing — e.g. Source: Minimoog oscillator → Modifier: MS-20 resonant HPF Q=8 → Controller: velocity-to-cutoff / Noise-driven rhythmic gate clock]

Linguistic Profile: [Phonetic character — e.g. Phonetic Scansion: iambic pentameter / Aspirated consonants / Hard stops on stressed syllables / Melismatic open vowels]
///*****///

Then write the complete song. Every section follows this structure:
[Section Name - Descriptor: energy/technical context]
(Production Note // Technical instruction e.g. "Sidechain pads to kick at 50Hz")
[Technical cue: e.g. Neural Floor: Activated / Vocal Identity: dry intimacy / Automation: Filter Cutoff sweeping / Granular Block: grain duration 20ms]
[Technical cue 2: additional production direction]
ACTUAL SUNG LYRIC LINES — real words, 4 lines per stanza minimum
(Performance: technique — e.g. [raspy], [vocal fry], (whispered), (soaring melismatic))

Chorus sections MUST include ALL of:
[Production: Full frequency activation, +6-8dB energy jump from verse]
[Vocal: (belted), (soaring), [stacked harmonies], [widened stereo double-track]]
[Signal Chain: SSL 4000G saturation, 1kHz presence boost +2dB, 1176 limiting 4:1]
Plus ad-libs: (yeah!), (oh-oh), (come on!), (hey!)
Plus vowel elongation: "sta-a-ay", "lo-o-ove", "hea-ea-eart"

Bridge MUST include THE SILENCE TRICK:
[Breakdown: Remove drums/bass, sustained pad only]
(Musical Event: 0.5s total digital silence before final transition)
[Vocal: (breathy falsetto), [melismatic cadence runs]]

Outro ends with:
[Atmosphere: Fading into field recording / White noise floor -60dBFS]
[Deconstruction: Lead synthesis de-tuning, decay expansion to 4s tail]
[End: Hard stop without artifacts]

Song flow: [Intro - Atmospheric/Acousmatic] → [Verse 1 - Narrative Context] → [Pre-Chorus - Tension Builder: Subtractive Arranging] → [Chorus - The Spectacular Hook: Interest Catalyst] → [Verse 2] → [Pre-Chorus] → [Chorus] → [Instrumental Break - Microsound/Glitch Showcase] → [Bridge - Contrast: The Silence Trick] → [Final Chorus] → [Outro - Fission: Elements Separating]

CRITICAL: Every section must contain REAL SUNG LYRIC LINES — actual words that would be performed. Never fill a section with only bracketed production cues. Cues wrap and annotate the lyrics, they do not replace them.>

===END===`;


    const callArgs = {
      model: AI_MODEL,
      max_tokens: 8192,  // style(999) + lyrics(4999) + neg(199) + JSON overhead ≈ 2500 tokens; 8192 is Gemini Flash ceiling
      response_format: { type: "json_object" as const },
      messages: [
        { role: "system" as const, content: SYSTEM_PROMPT },
        { role: "user" as const, content: singleCallPrompt },
      ],
    };

    // One 429-retry with 8-second backoff
    const completion = await openai.chat.completions.create(callArgs)
      .catch(async (err: unknown) => {
        if ((err as { status?: number })?.status === 429) {
          console.warn("[ai] 429 rate limit — waiting 8s then retrying once...");
          await new Promise(r => setTimeout(r, 8000));
          return openai.chat.completions.create(callArgs);
        }
        throw err;
      });

    // Track token usage for cost monitoring
    if (completion.usage) {
      trackUsage(AI_MODEL, completion.usage.prompt_tokens ?? 0, completion.usage.completion_tokens ?? 0, "generate-template");
    }

    const raw = completion.choices[0]?.message?.content ?? "";
    if (!raw) throw new Error("AI returned empty response. Please try again.");

    // ── Parse response — try delimiters first, fall back to JSON ─────────────
    // Gemini sometimes returns JSON even without response_format: json_object.
    const extract = (text: string, tag: string): string => {
      const start = text.indexOf(`===${tag}===`);
      if (start === -1) return "";
      const after = text.indexOf("\n", start) + 1;
      const nextDelim = text.indexOf("===", after);
      return (nextDelim === -1 ? text.slice(after) : text.slice(after, nextDelim)).trim();
    };

    // Strip markdown code fences if present (```json ... ```)
    const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

    let styleOfMusic: string;
    let title: string;
    let negativePrompt: string;
    let lyrics: string;

    const delimStyle = extract(stripped, "STYLE");
    if (delimStyle) {
      // Delimiter format succeeded
      styleOfMusic   = delimStyle;
      title          = extract(stripped, "TITLE") || "Untitled";
      negativePrompt = extract(stripped, "NEGATIVE");
      lyrics         = extract(stripped, "LYRICS");
      console.log(`[ai:delim] style=${styleOfMusic.length} lyrics=${lyrics.length} neg=${negativePrompt.length}`);
    } else {
      // Try JSON fallback (Gemini defaults to JSON)
      try {
        const parsed = JSON.parse(stripped) as Record<string, string>;
        styleOfMusic   = parsed.styleOfMusic   ?? parsed.style          ?? "";
        title          = parsed.title          ?? parsed.songTitle       ?? "Untitled";
        negativePrompt = parsed.negativePrompt ?? parsed.negative        ?? "";
        lyrics         = parsed.lyrics                                   ?? "";
        console.log(`[ai:json] style=${styleOfMusic.length} lyrics=${lyrics.length} neg=${negativePrompt.length}`);
      } catch (jsonErr) {
        console.warn("[ai] JSON.parse failed:", (jsonErr as Error).message, "Raw length:", raw.length);
        console.warn("[ai] Raw start:", raw.slice(0, 200));
        console.warn("[ai] Raw end:", raw.slice(-200));
        // Third fallback: regex-extract individual fields from possibly-truncated JSON
        const extractJsonField = (text: string, field: string): string => {
          // Match "field": "value" — value may contain escaped quotes, stop at unescaped closing quote
          const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`);
          const m = text.match(re);
          return m ? m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : "";
        };
        const rxStyle = extractJsonField(stripped, "styleOfMusic") || extractJsonField(stripped, "style");
        const rxLyrics = extractJsonField(stripped, "lyrics");
        const rxNeg = extractJsonField(stripped, "negativePrompt") || extractJsonField(stripped, "negative");
        const rxTitle = extractJsonField(stripped, "title") || extractJsonField(stripped, "songTitle");
        if (rxStyle && rxLyrics) {
          styleOfMusic   = rxStyle;
          title          = rxTitle || "Untitled";
          negativePrompt = rxNeg;
          lyrics         = rxLyrics;
          console.log(`[ai:regex] style=${styleOfMusic.length} lyrics=${lyrics.length} neg=${negativePrompt.length}`);
        } else {
          console.warn("[ai] all parsers failed — regex matches:", { style: !!rxStyle, lyrics: !!rxLyrics, neg: !!rxNeg, title: !!rxTitle });
          throw new Error("AI response format was unexpected. Please try again.");
        }
      }
    }

    if (!styleOfMusic || !lyrics) {
      console.warn("[ai] empty fields after parse — raw snippet:", raw.slice(0, 300));
      throw new Error("AI returned incomplete data. Please try again.");
    }

    return { styleOfMusic, title, lyrics, negativePrompt };
  };

  onStage?.("ai-generating");

  if (templateCacheKey) {
    const cached = cacheGet<AiOutput>(templateCacheKey);
    if (cached) {
      aiResult = cached;
      templateFromCache = true;
      console.log(`[cache] template HIT for ${videoId}`);
    } else {
      aiResult = await runAiCall();
      cacheSet(templateCacheKey, aiResult, TTL.TEMPLATE);
      console.log(`[cache] template SET for ${videoId}`);
    }
  } else {
    aiResult = await runAiCall();
  }

  onStage?.("validating");

  // ── Python character-count validation + smart trim ───────────────────────
  // Python len() counts Unicode code points; JS .length counts UTF-16 units.
  // They differ for emoji (🔥 = 1 in Python, 2 in JS).  Python is the
  // authoritative counter.  The validator also trims fields that exceed the
  // max limit (newline boundary for lyrics, comma boundary for style/negative)
  // and returns the corrected values — we apply them back to aiResult.
  try {
    const pyReport = await validateWithPython({
      styleOfMusic:   aiResult.styleOfMusic,
      lyrics:         aiResult.lyrics,
      negativePrompt: aiResult.negativePrompt,
      artistName:     metadata.cleanArtist,
    });
    if (pyReport) {
      const { fields, valid, trimmed, padded, errors } = pyReport;
      const sm = fields.styleOfMusic;
      const ly = fields.lyrics;
      const np = fields.negativePrompt;
      console.log(
        `[py-validate] style  JS=${aiResult.styleOfMusic.length} PY=${sm?.original}→${sm?.final} ok=${sm?.ok}  ` +
        `lyrics JS=${aiResult.lyrics.length} PY=${ly?.original}→${ly?.final} ok=${ly?.ok}  ` +
        `neg JS=${aiResult.negativePrompt.length} PY=${np?.original}→${np?.final} ok=${np?.ok}  ` +
        `valid=${valid} trimmed=${trimmed} padded=${padded}`
      );
      if (errors.length) {
        console.warn(`[py-validate] ISSUES (unfixable): ${errors.join(" | ")}`);
      }
      // Apply Python values — covers both trim-down and pad-up corrections
      if (trimmed || padded) {
        aiResult = { ...aiResult, ...pyReport.data };
        const action = trimmed && padded ? "trimmed+padded" : trimmed ? "trimmed" : "padded";
        console.log(`[py-validate] applied ${action} values to response`);
      }
    }
  } catch { /* never block generation */ }

  const fromCache = baseFromCache && featuresFromCache && lyricsFromCache && templateFromCache;

  const fingerprint = computeFingerprint({
    audioFeatures,
    isInstrumental,
    vocalGender: vocalGender ?? "auto",
    energyLevel: energyLevel ?? "auto",
    era: era ?? "auto",
    tempo,
    styleOfMusic: aiResult.styleOfMusic,
    tags: [],
    musicBrainzGenres: base.musicBrainz?.genres ?? [],
    keywords: base.keywords,
    videoId: videoId ?? undefined,
    songTitle: base.cleanTitle,
    artist: base.cleanArtist || base.author,
  });

  return GenerateSunoTemplateResponse.parse({
    songTitle: metadata.title,
    artist: metadata.cleanArtist || metadata.author,
    styleOfMusic: trimStylePrompt(aiResult.styleOfMusic, 999),
    title: aiResult.title,
    lyrics: trimToCharLimit(aiResult.lyrics, 4999),
    negativePrompt: aiResult.negativePrompt,
    tags: [],
    lyricsStructure: lyricsStructure ?? undefined,
    suggestedDefaults: Object.keys(suggestedDefaults.sources).length > 0 ? suggestedDefaults : undefined,
    fromCache,
    fingerprint,
    audioFeatures: audioFeatures ?? undefined,
  });
}

router.post("/generate-template", async (req, res) => {
  const parsed = GenerateSunoTemplateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body. Please provide a youtubeUrl." });
    return;
  }
  try {
    const template = await generateOneTemplate(parsed.data);
    res.json(template);
  } catch (err: unknown) {
    console.error("Error generating template:", err);
    const message = err instanceof Error ? err.message : "An unexpected error occurred";
    const isClientError =
      message.includes("Invalid YouTube URL") ||
      message.includes("Could not fetch video metadata");
    res.status(isClientError ? 400 : 500).json({ error: message });
  }
});

/**
 * POST /api/generate-template/stream
 * Same generation pipeline as /api/generate-template, but streams stage progress via SSE
 * so the frontend can show what's happening instead of a bare spinner. Final event carries
 * the full template payload — the plain JSON endpoint above is unaffected and still works.
 */
router.post("/generate-template/stream", async (req, res) => {
  const parsed = GenerateSunoTemplateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body. Please provide a youtubeUrl." });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let clientDisconnected = false;
  res.on("close", () => { clientDisconnected = true; });

  const heartbeat = setInterval(() => {
    if (!clientDisconnected) res.write(": heartbeat\n\n");
  }, 20000);

  const sendEvent = (type: string, data: unknown) => {
    if (!clientDisconnected) {
      res.write(`data: ${JSON.stringify({ type, ...(typeof data === "object" && data !== null ? data : { data }) })}\n\n`);
    }
  };

  try {
    const template = await generateOneTemplate(parsed.data, (stage) => {
      sendEvent("stage", { stage });
    });
    sendEvent("done", { template });
  } catch (err: unknown) {
    console.error("Error generating template (stream):", err);
    const message = err instanceof Error ? err.message : "An unexpected error occurred";
    sendEvent("error", { error: message });
  } finally {
    clearInterval(heartbeat);
    if (!clientDisconnected) res.end();
  }
});

/**
 * POST /api/generate-variations
 * Generates count (2–4) template variations in parallel, each with a different creative angle.
 * Returns { variations: SunoTemplate[] } — partial success is allowed (at least 1 must succeed).
 */
router.post("/generate-variations", async (req, res) => {
  const parsed = GenerateVariationsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body. Please provide a youtubeUrl." });
    return;
  }

  const count = Math.min(Math.max(Math.round(parsed.data.count ?? 2), 1), 4);

  console.log(`[variations] Generating ${count} variations for ${parsed.data.youtubeUrl}`);

  try {
    const results = await Promise.allSettled(
      Array.from({ length: count }, (_, i) =>
        generateOneTemplate({ ...parsed.data, variationIndex: i + 1 })
      )
    );

    const slots = results.map((r, i) => {
      const variationIndex = i + 1;
      if (r.status === "fulfilled") {
        return { variationIndex, template: r.value };
      }
      const msg = r.reason instanceof Error ? r.reason.message : "Generation failed";
      return { variationIndex, error: msg };
    });

    const variations = slots
      .filter((s): s is { variationIndex: number; template: ReturnType<typeof GenerateSunoTemplateResponse.parse> } => "template" in s && s.template !== undefined)
      .map((s) => s.template);

    if (variations.length === 0) {
      const firstErrMsg = slots.find((s) => "error" in s)?.error ?? "All variations failed to generate";
      const isClientError =
        firstErrMsg.includes("Invalid YouTube URL") ||
        firstErrMsg.includes("Could not fetch video metadata");
      res.status(isClientError ? 400 : 500).json({ error: firstErrMsg });
      return;
    }

    console.log(`[variations] ${variations.length}/${count} variations succeeded`);
    res.json({ slots, variations });
  } catch (err: unknown) {
    console.error("Error generating variations:", err);
    const message = err instanceof Error ? err.message : "An unexpected error occurred";
    const isClientError =
      message.includes("Invalid YouTube URL") ||
      message.includes("Could not fetch video metadata");
    res.status(isClientError ? 400 : 500).json({ error: message });
  }
});

// ─── Playlist info endpoint ────────────────────────────────────────────────────

const PLAYLIST_CAP = 20;

/**
 * Extract playlist ID from a YouTube playlist or video URL with list= param.
 */
function extractPlaylistId(url: string): string | null {
  try {
    const u = new URL(url);
    return u.searchParams.get("list") ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch playlist video IDs and titles using the YouTube oEmbed API + RSS feed.
 * Uses the public YouTube RSS feed which doesn't require an API key.
 * Cap at PLAYLIST_CAP (20) videos.
 */
async function fetchPlaylistTracks(
  playlistId: string
): Promise<{ tracks: { videoId: string; title: string; url: string; thumbnail?: string }[]; truncated: boolean }> {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId}`;
  const resp = await fetch(feedUrl, {
    headers: { "User-Agent": "SunoTemplateGenerator/1.0" },
    signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) throw new Error(`Could not fetch playlist feed (status ${resp.status})`);

  const xml = await resp.text();

  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  const videoIdRegex = /<yt:videoId>([^<]+)<\/yt:videoId>/;
  const titleRegex = /<title>([^<]+)<\/title>/;

  // Collect up to PLAYLIST_CAP + 1 entries to detect whether there are more beyond the cap
  const allParsed: { videoId: string; title: string; url: string; thumbnail?: string }[] = [];
  let match;
  while ((match = entryRegex.exec(xml)) !== null && allParsed.length <= PLAYLIST_CAP) {
    const entry = match[1];
    const videoIdMatch = videoIdRegex.exec(entry);
    const titleMatch = titleRegex.exec(entry);
    if (!videoIdMatch || !titleMatch) continue;
    const videoId = videoIdMatch[1].trim();
    const rawTitle = decodeHtmlEntities(titleMatch[1]).trim();
    allParsed.push({
      videoId,
      title: rawTitle,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    });
  }
  // Truncate to cap and return with a flag indicating whether truncation occurred
  const truncated = allParsed.length > PLAYLIST_CAP;
  return { tracks: allParsed.slice(0, PLAYLIST_CAP), truncated };
}

/**
 * GET /api/playlist-info?url=...
 * Fetches playlist metadata (video IDs, titles, thumbnails) for a YouTube playlist URL.
 */
router.get("/playlist-info", async (req, res) => {
  const url = String(req.query.url ?? "");
  if (!url) {
    res.status(400).json({ error: "Missing url query parameter" });
    return;
  }

  const playlistId = extractPlaylistId(url);
  if (!playlistId) {
    res.status(400).json({ error: "URL does not contain a valid YouTube playlist ID (list= param)" });
    return;
  }

  try {
    const { tracks, truncated } = await fetchPlaylistTracks(playlistId);
    if (tracks.length === 0) {
      res.status(404).json({ error: "Playlist is empty or could not be read. Make sure it is public." });
      return;
    }

    res.json({
      playlistId,
      tracks,
      totalCount: tracks.length,
      capped: truncated,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to fetch playlist";
    console.error("[playlist-info] error:", message);
    res.status(500).json({ error: message });
  }
});

// ─── Batch generate endpoint (SSE streaming) ──────────────────────────────────

const BATCH_CONCURRENCY = 3;

/**
 * POST /api/batch
 * Accepts an array of YouTube URLs (up to 20) and streams progress via Server-Sent Events.
 * Each SSE event is a JSON object: { type: "progress" | "done" | "error", track: BatchTrackResult }
 * Processes up to BATCH_CONCURRENCY tracks at a time.
 */
router.post("/batch", async (req, res) => {
  const parsed = BatchGenerateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request. Provide an array of urls (1–20)." });
    return;
  }

  const { urls, ...sharedOpts } = parsed.data;

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Track client disconnect so we can stop processing early
  let clientDisconnected = false;
  res.on("close", () => { clientDisconnected = true; });

  // Send periodic SSE heartbeat comments to prevent proxy idle timeouts
  const heartbeat = setInterval(() => {
    if (!clientDisconnected) res.write(": heartbeat\n\n");
  }, 20000);

  const sendEvent = (type: string, data: unknown) => {
    if (!clientDisconnected) {
      res.write(`data: ${JSON.stringify({ type, ...( typeof data === "object" && data !== null ? data : { data }) })}\n\n`);
    }
  };

  // Send initial queued status for all tracks
  const urlList: string[] = urls;
  const tracks = urlList.map((url: string, index: number) => ({
    url,
    videoId: videoIdFromUrl(url) ?? "",
    status: "queued" as const,
    index,
  }));

  for (const t of tracks) {
    sendEvent("progress", { track: { ...t, status: "queued" } });
  }

  // Process with concurrency limit
  let idx = 0;

  async function processNext(): Promise<void> {
    if (idx >= tracks.length || clientDisconnected) return;
    const track = tracks[idx++];

    sendEvent("progress", { track: { ...track, status: "analyzing" } });

    try {
      sendEvent("progress", { track: { ...track, status: "generating" } });

      const template = await generateOneTemplate({
        youtubeUrl: track.url,
        ...sharedOpts,
      });

      // Try to grab thumbnail from ytdl or ytimg
      const thumbnailUrl = `https://i.ytimg.com/vi/${track.videoId}/mqdefault.jpg`;

      const result = {
        ...track,
        title: template.songTitle,
        thumbnail: thumbnailUrl,
        status: "done" as const,
        template,
      };
      sendEvent("progress", { track: result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Generation failed";
      const result = {
        ...track,
        status: "failed" as const,
        error: message,
      };
      sendEvent("progress", { track: result });
    }
  }

  try {
    const workers: Promise<void>[] = [];
    for (let w = 0; w < Math.min(BATCH_CONCURRENCY, urls.length); w++) {
      workers.push((async () => {
        // Guard outer loop against disconnect to prevent infinite spin
        while (!clientDisconnected && idx < tracks.length) {
          await processNext();
        }
      })());
    }
    await Promise.all(workers);
  } catch (err) {
    console.error("[batch] unexpected error:", err);
  } finally {
    // Always clean up heartbeat and close stream, even on error or early exit
    clearInterval(heartbeat);
    if (!clientDisconnected) {
      sendEvent("done", { totalCount: tracks.length });
      res.end();
    }
  }
});

/**
 * GET /api/suggest?title=...&artist=...
 * Accepts the clean song title and artist directly (passed by the frontend after youtube-preview resolves).
 * Uses MusicBrainz for release year/era, then AI to identify genres/energy/tempo.
 */
router.get("/suggest", async (req, res) => {
  const title = (req.query.title as string ?? "").trim();
  const artist = (req.query.artist as string ?? "").trim();

  if (!title) {
    res.status(400).json({ error: "title query param is required" });
    return;
  }

  // Build enums here so both the JSON schema and validators stay in sync.
  const ERA_ENUM = ["50s", "60s", "70s", "80s", "90s", "2000s", "2010s", "modern"] as const;
  const ENERGY_ENUM = ["very chill", "chill", "medium", "high", "intense"] as const;
  const TEMPO_ENUM = ["ballad", "slow", "mid", "groove", "uptempo", "fast", "hyper"] as const;
  const VOCALS_ENUM = ["male", "female", "mixed", "duet", "no vocals"] as const;
  const GENRE_LIST = ["Pop","Dance Pop","Indie Pop","Synth-Pop","Dream Pop","Art Pop","Electropop","Britpop","Rock","Alternative Rock","Indie Rock","Hard Rock","Classic Rock","Punk","Post-Punk","Grunge","Shoegaze","Psychedelic Rock","Progressive Rock","Garage Rock","Folk Rock","Arena Rock","New Wave","Emo","Post-Rock","Stoner Rock","Hip-Hop","Trap","Rap","Drill","Boom Bap","Gangsta Rap","G-Funk","Grime","Cloud Rap","Phonk","R&B","Soul","Neo-Soul","Funk","Disco","Motown","Gospel","Contemporary R&B","Jazz","Smooth Jazz","Bebop","Swing","Jazz Fusion","Big Band","Acid Jazz","Cool Jazz","Latin Jazz","Free Jazz","Metal","Heavy Metal","Black Metal","Death Metal","Thrash Metal","Nu Metal","Metalcore","Power Metal","Doom Metal","Symphonic Metal","Djent","Country","Americana","Bluegrass","Folk","Indie Folk","Outlaw Country","Country Rock","Country Pop","Alt-Country","Classical","Orchestral","Baroque","Cinematic","Film Score","Opera","Minimalist","Reggae","Dancehall","Reggaeton","Latin Pop","Bossa Nova","Flamenco","Salsa","K-Pop","J-Pop","Afrobeats","Blues","Delta Blues","Chicago Blues","Electric Blues","House","Deep House","Tech House","Progressive House","Acid House","Melodic House","Afro House","Soulful House","Chicago House","Nu Disco","Techno","Berlin Techno","Detroit Techno","Minimal Techno","Hard Techno","Dub Techno","Trance","Progressive Trance","Uplifting Trance","Psytrance","Goa Trance","Vocal Trance","Future Rave","Drum & Bass","Liquid DnB","Neurofunk","Darkstep","Jump Up","Jungle","Dubstep","Post-Dubstep","Brostep","Riddim","Future Bass","Breakbeat","Big Beat","Glitch Hop","Synthwave","Darksynth","Outrun","Retrowave","Chillwave","Hi-NRG","Italo Disco","Futurepop","Electro","EBM","Industrial","Darkwave","Cold Wave","EDM","Big Room","Electro House","Ambient","Dark Ambient","IDM","Glitch","Space Music","Drone Ambient","New Age","Trip-Hop","Downtempo","Chillhop","Lo-Fi","Vaporwave","Future Funk","Hardcore","Gabber","Hardstyle","UK Garage","2-Step","UK Bass","Memphis Phonk","Hyperpop","Amapiano","Gqom","Baile Funk","Footwork"] as const;
  const MOOD_LIST = ["Dark","Euphoric","Nostalgic","Melancholic","Aggressive","Romantic","Dreamy","Rebellious","Playful","Mysterious","Cinematic","Hopeful","Angry","Tender","Haunted","Triumphant","Vulnerable","Defiant","Serene","Intense","Wistful","Bittersweet","Groovy","Frantic","Ethereal","Hypnotic","Brooding","Raw","Gritty","Majestic","Eerie","Sensual","Savage","Soulful","Cathartic","Blissful","Chaotic","Anxious","Desolate","Primal","Lush","Fierce","Longing","Psychedelic","Icy","Dusty","Tense","Laid-back","Transcendent","Unsettling","Festive","Murky","Euphoric-Sad","Punchy","Stormy","Intimate","Epic","Uneasy","Crystalline","Quirky"] as const;
  const INSTRUMENT_LIST = ["Piano","Guitar","Synth","Strings","Bass","Choir","Brass","Drums","Violin","Flute","Organ","Sitar","Cello","Saxophone","Trumpet","Harp","Banjo","Ukulele","Mandolin","Marimba","Theremin","Mellotron","Pedal Steel","Dulcimer","808","Acoustic Guitar","Electric Guitar","Harmonica","Accordion","Vibraphone","Glockenspiel","Rhodes","Clarinet","Oboe","French Horn","Tabla","Congas","Sub Bass","Pad","Wurlitzer","Harpsichord","Bagpipes","Moog","Oud","Koto","Erhu","Steel Drums","Trombone","Bassoon","Bansuri","Lap Steel","Didgeridoo"] as const;
  const VOICE_LIST = ["Male Voice","Female Voice","Soprano","Coloratura Soprano","Soubrette","Mezzo-Soprano","Coloratura Mezzo-Soprano","Cabaret Mezzo","Alto","Dramatic Alto","Alto Profondo","Tenor","Spinto Tenor","Counter-Tenor","Baritone","Verdi Baritone","Baryton-Martin","Bass","Lyric Bass","Basso Cantante","Gospel Choirs","Barbershop Quartets","Female Emotive Voice","Jamaican Slang","Robotic Vocals","Very Robotic Vocals","Female AI","Clear and Melodious Voice","Rapid-Fire Rap","Gentle Voice","Miku Voice","Vocaloid","Speak Fast","Male Singer","Children's Spoken Word","Circular Breathing","Ingressive Phonation","Microtonal Singing","Beatboxing","Throat Singing","Vocal Fry","Whistle Register","Shibuya-kei","Emotional Depth Vocal","Vocal Add-ons","Muffled Voice","Spanish Male Sensual Voice","Whispering Voice"] as const;

  try {
    // Run MusicBrainz and AI in parallel for speed
    const [mbData, aiSuggestion] = await Promise.all([
      Promise.race([
        fetchMusicBrainzData(artist, title),
        new Promise<MusicBrainzData>((resolve) => setTimeout(() => resolve({}), 7000)),
      ]),
      (async () => {
        try {
          // Strict JSON-schema response — guarantees every required field is
          // present and every enum value is valid. This is the only reliable
          // way to stop the model from omitting fields or returning "auto".
          const songStyleSchema = {
            type: "object",
            additionalProperties: false,
            required: ["genres", "era", "energy", "tempo", "vocals", "moods", "instruments", "voices", "nudge"],
            properties: {
              genres: {
                type: "array",
                description: `Exactly 5 genres, most dominant first. You MUST choose ONLY from this list: ${GENRE_LIST.join(", ")}`,
                items: { type: "string" },
              },
              era: { type: "string", enum: ERA_ENUM },
              energy: { type: "string", enum: ENERGY_ENUM },
              tempo: { type: "string", enum: TEMPO_ENUM },
              vocals: { type: "string", enum: VOCALS_ENUM },
              moods: {
                type: "array",
                description: `Exactly 4 moods. You MUST choose ONLY from this list: ${MOOD_LIST.join(", ")}`,
                items: { type: "string" },
              },
              instruments: {
                type: "array",
                description: `Exactly 5 instruments. You MUST choose ONLY from this list: ${INSTRUMENT_LIST.join(", ")}`,
                items: { type: "string" },
              },
              voices: {
                type: "array",
                description: `Exactly 2 vocal type/technique/character tags that best fit this song's actual singer(s) — voice classification (e.g. Tenor, Mezzo-Soprano), delivery style (e.g. Rapid-Fire Rap, Whispering Voice), or vocal effect (e.g. Robotic Vocals) as appropriate. If the song is confirmed instrumental, still pick the 2 tags a hypothetical vocal version would suit best. You MUST choose ONLY from this list: ${VOICE_LIST.join(", ")}`,
                items: { type: "string" },
              },
              nudge: {
                type: "string",
                description: "3-8 word creative style descriptor, non-empty.",
              },
            },
          };

          const completion = await openai.chat.completions.create({
            model: AI_MINI_MODEL,
            max_tokens: 700,
            response_format: {
              type: "json_schema",
              json_schema: { name: "song_style", strict: true, schema: songStyleSchema },
            },
            messages: [
              {
                role: "system",
                content: `You are a music expert. For the given song, fill EVERY field in the JSON schema. The valid values are defined by the schema enums — you MUST pick from them. Counts are strict: genres exactly 5 (most-to-least dominant), moods exactly 4, instruments exactly 5, voices exactly 2. For "vocals", pick "no vocals" ONLY for confirmed instrumentals — otherwise commit to male/female/mixed/duet. For "voices", pick the 2 tags that most specifically describe the actual singer(s)' voice type or delivery style — never hedge with the two most generic options unless genuinely nothing more specific fits. For "nudge", write a 3-8 word creative style descriptor (e.g. "punchy 808s with cinematic strings"). Commit to specific choices based on the song title, artist style, and genre conventions — never hedge.`,
              },
              {
                role: "user",
                content: artist ? `Song: "${title}" by ${artist}` : `Song: "${title}"`,
              },
            ],
          }, { timeout: 9000 });
          if (completion.usage) {
            trackUsage(AI_MINI_MODEL, completion.usage.prompt_tokens ?? 0, completion.usage.completion_tokens ?? 0, "suggest");
          }
          const raw = completion.choices[0]?.message?.content ?? "{}";
          return JSON.parse(raw) as { genres?: string[]; era?: string; energy?: string; tempo?: string; vocals?: string; moods?: string[]; instruments?: string[]; voices?: string[]; nudge?: string };
        } catch (aiErr) {
          console.error("[suggest] AI suggestion failed with error:", aiErr);
          return {};
        }
      })(),
    ]);

    const mbTags = mbData.genres ?? [];
    const mbGenres = mapMbTagsToGenres(mbTags);

    const VALID_ERAS = new Set<string>(ERA_ENUM);
    const VALID_ENERGIES = new Set<string>(ENERGY_ENUM);
    const VALID_TEMPOS = new Set<string>(TEMPO_ENUM);
    const VALID_VOCALS = new Set<string>(VOCALS_ENUM);
    const VALID_GENRES = new Set<string>(GENRE_LIST);
    const VALID_MOODS = new Set<string>(MOOD_LIST);
    const VALID_INSTRUMENTS = new Set<string>(INSTRUMENT_LIST);
    const VALID_VOICES = new Set<string>(VOICE_LIST);

    // ── GENRES: AI → MB fallback → defaults; pad to exactly 5 ──
    const aiGenres = (aiSuggestion.genres ?? [])
      .filter((g): g is string => typeof g === "string" && VALID_GENRES.has(g));
    const dedupGenres: string[] = [];
    const seenG = new Set<string>();
    for (const g of [...aiGenres, ...mbGenres, ...DEFAULT_GENRES]) {
      if (!seenG.has(g) && VALID_GENRES.has(g)) { dedupGenres.push(g); seenG.add(g); }
      if (dedupGenres.length >= 5) break;
    }
    const genres = dedupGenres;

    // ── ERA: MB year wins (most authoritative) → AI → fallback "modern" ──
    const mbEra = yearToEra(mbData.releaseYear);
    const aiEra = typeof aiSuggestion.era === "string" && VALID_ERAS.has(aiSuggestion.era) ? aiSuggestion.era : null;
    const era = mbEra ?? aiEra ?? "modern";

    // ── ENERGY / TEMPO: AI → inferred from genres → safe default ──
    const aiEnergy = typeof aiSuggestion.energy === "string" && VALID_ENERGIES.has(aiSuggestion.energy) ? aiSuggestion.energy : null;
    const aiTempo = typeof aiSuggestion.tempo === "string" && VALID_TEMPOS.has(aiSuggestion.tempo) ? aiSuggestion.tempo : null;
    const energy = aiEnergy ?? inferEnergy(genres) ?? "medium";
    const tempo = aiTempo ?? inferTempo(genres) ?? "mid";

    // ── VOCALS: AI (excluding "auto") → inferred from genres → "mixed" ──
    const aiVocals = typeof aiSuggestion.vocals === "string" && VALID_VOCALS.has(aiSuggestion.vocals) && aiSuggestion.vocals !== "auto"
      ? aiSuggestion.vocals
      : null;
    const vocals = aiVocals ?? inferVocals(genres);

    // ── MOODS: AI valid items → genre-inferred fill → defaults; exactly 4 ──
    const aiMoods = (aiSuggestion.moods ?? [])
      .filter((m): m is string => typeof m === "string" && VALID_MOODS.has(m));
    const moodFill = inferMoods(genres, VALID_MOODS);
    const seenM = new Set<string>();
    const moods: string[] = [];
    for (const m of [...aiMoods, ...moodFill, ...DEFAULT_MOODS]) {
      if (!seenM.has(m) && VALID_MOODS.has(m)) { moods.push(m); seenM.add(m); }
      if (moods.length >= 4) break;
    }

    // ── INSTRUMENTS: AI valid items → genre-inferred fill → defaults; exactly 5 ──
    const aiInstruments = (aiSuggestion.instruments ?? [])
      .filter((i): i is string => typeof i === "string" && VALID_INSTRUMENTS.has(i));
    const instFill = inferInstruments(genres);
    const seenI = new Set<string>();
    const instruments: string[] = [];
    for (const i of [...aiInstruments, ...instFill, ...DEFAULT_INSTRUMENTS]) {
      if (!seenI.has(i) && VALID_INSTRUMENTS.has(i)) { instruments.push(i); seenI.add(i); }
      if (instruments.length >= 5) break;
    }

    // ── VOICES: AI valid items → fallback derived from the already-resolved vocal type ──
    const aiVoices = (aiSuggestion.voices ?? [])
      .filter((v): v is string => typeof v === "string" && VALID_VOICES.has(v));
    const voiceFallback: Record<string, string[]> = {
      male: ["Male Voice", "Male Singer"],
      female: ["Female Voice", "Female Emotive Voice"],
      mixed: ["Male Voice", "Female Voice"],
      duet: ["Male Voice", "Female Voice"],
      "no vocals": [],
    };
    const seenV = new Set<string>();
    const voices: string[] = [];
    for (const v of [...aiVoices, ...(voiceFallback[vocals] ?? [])]) {
      if (!seenV.has(v) && VALID_VOICES.has(v)) { voices.push(v); seenV.add(v); }
      if (voices.length >= 2) break;
    }

    // ── NUDGE: AI trimmed → inferred ──
    const aiNudge = typeof aiSuggestion.nudge === "string" && aiSuggestion.nudge.trim().length > 0
      ? aiSuggestion.nudge.trim()
      : null;
    const nudge = aiNudge ?? inferNudge(genres, energy, tempo);

    console.log(`[suggest] ${artist} – ${title} → genres:[${genres.join(",")}] era:${era} energy:${energy} tempo:${tempo} vocals:${vocals} moods:[${moods.join(",")}] instruments:[${instruments.join(",")}] voices:[${voices.join(",")}] nudge:"${nudge}" (aiOk=${Object.keys(aiSuggestion).length > 0})`);

    res.json({ genres, era, energy, tempo, vocals, moods, instruments, voices, nudge, songTitle: title, artist, mbTags });
  } catch (err) {
    console.error("suggest error:", err);
    res.status(500).json({ error: "Could not fetch suggestions" });
  }
});

/**
 * GET /api/youtube-preview?url=...
 * Lightweight endpoint — returns just thumbnail, title, author for the song preview card.
 * Does NOT fetch lyrics or call AI.
 */
router.get("/youtube-preview", async (req, res) => {
  const url = req.query.url as string;
  if (!url || !isValidYouTubeUrl(url)) {
    res.status(400).json({ error: "Invalid YouTube URL" });
    return;
  }

  const videoId = videoIdFromUrl(url);
  // YouTube always serves the mqdefault thumbnail for any public video
  const thumbFallback = videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : null;

  // ── Strategy 1: oEmbed (works for all public videos, no rate-limit, no bot-detection) ──
  try {
    const oembed = await fetchViaOembed(url);
    const { cleanTitle, cleanArtist } = cleanSongTitle(oembed.title, oembed.author);
    // oEmbed gives a 120x90 thumb — prefer our mqdefault URL which is larger
    const thumbnail = thumbFallback ?? oembed.thumbnail ?? null;
    console.log(`[youtube-preview] oEmbed OK: "${cleanTitle}" by "${cleanArtist}"`);
    res.json({ title: oembed.title, cleanTitle, author: cleanArtist || oembed.author, thumbnail, duration: null });
    return;
  } catch {
    console.warn("[youtube-preview] oEmbed failed — trying ytdl fallback");
  }

  // ── Strategy 2: ytdl-core (has richer data but often blocked on RPi) ──
  try {
    const info = await Promise.race([
      ytdl.getBasicInfo(url, {
        requestOptions: { headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9" } },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ytdl timeout")), 5000)),
    ]);
    const vd = info.videoDetails;
    const { cleanTitle, cleanArtist } = cleanSongTitle(vd.title ?? "", vd.author?.name ?? "");
    const thumb = vd.thumbnails?.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? thumbFallback;
    console.log(`[youtube-preview] ytdl OK: "${cleanTitle}" by "${cleanArtist}"`);
    res.json({
      title: vd.title ?? "Unknown Title",
      cleanTitle,
      author: cleanArtist || vd.author?.name || "Unknown Artist",
      thumbnail: thumb,
      duration: vd.lengthSeconds ? formatDuration(Number(vd.lengthSeconds)) : null,
    });
  } catch {
    // fall through to Strategy 3
  }

  // ── Strategy 3: Parse og:title from YouTube page HTML ──
  if (videoId) {
    try {
      const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(6000),
      });
      if (pageResp.ok) {
        const html = await pageResp.text();
        const m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
          ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
        if (m?.[1]) {
          const rawTitle = decodeHtmlEntities(m[1]);
          const { cleanTitle, cleanArtist } = cleanSongTitle(rawTitle, "");
          if (cleanTitle) {
            console.log(`[youtube-preview] HTML fallback OK: "${cleanTitle}" by "${cleanArtist}"`);
            res.json({ title: rawTitle, cleanTitle, author: cleanArtist || "", thumbnail: thumbFallback, duration: null });
            return;
          }
        }
      }
    } catch (err3) {
      console.warn("[youtube-preview] HTML fallback failed:", (err3 as Error).message?.slice(0, 80));
    }
  }

  // All strategies exhausted — return thumbnail only
  console.error("[youtube-preview] all strategies failed");
  res.json({ title: "", cleanTitle: "", author: "", thumbnail: thumbFallback, duration: null });
});

/**
 * POST /api/pre-analyze-structure
 * Pre-generation endpoint: fetches lyrics for a YouTube URL and returns a LyricsStructure.
 * Called automatically after video preview loads, enabling structure editing BEFORE generation.
 */
router.post("/pre-analyze-structure", async (req, res) => {
  const { youtubeUrl } = req.body as { youtubeUrl?: string };
  if (!youtubeUrl || !isValidYouTubeUrl(youtubeUrl)) {
    res.status(400).json({ error: "Provide a valid YouTube URL." });
    return;
  }
  try {
    const vid = videoIdFromUrl(youtubeUrl);
    let metadata: VideoMetadata;

    if (vid) {
      // Stage 1: base metadata
      let base = cacheGet<BaseVideoMetadata>(`metadata:${vid}`);
      if (!base) {
        base = await fetchBaseMetadata(youtubeUrl);
        cacheSet(`metadata:${vid}`, base, TTL.METADATA);
      }
      // Stage 2: audio features (permanent) — populate cache opportunistically
      if (!cacheGet<CachedAudioFeatures>(`features:${vid}`)) {
        const result = await detectAudioFeatures({
          artist: base.cleanArtist,
          title: base.cleanTitle,
          youtubeUrl,
          descriptionBpm: base.descriptionData?.bpm,
          descriptionKey: base.descriptionData?.key,
        });
        cacheSet<CachedAudioFeatures>(`features:${vid}`, { features: result }, TTL.FEATURES);
      }
      // Stage 3: lyrics
      let cachedLyrics = cacheGet<CachedLyrics>(`lyrics:${vid}`);
      if (!cachedLyrics) {
        cachedLyrics = await fetchLyricsData(base.cleanArtist, base.cleanTitle, base.durationSeconds, base.captionText);
        cacheSet(`lyrics:${vid}`, cachedLyrics, TTL.LYRICS);
      }
      const cachedFeatures = cacheGet<CachedAudioFeatures>(`features:${vid}`);
      metadata = assembleMetadata(base, cachedLyrics, cachedFeatures?.features ?? undefined);
    } else {
      metadata = await fetchAllMetadata(youtubeUrl);
    }

    const lyricsForStructure = metadata.lyricsText ?? (metadata.lyricsSource === "captions" ? metadata.captionText : null);
    if (!lyricsForStructure || lyricsForStructure.trim().length < 30) {
      res.status(404).json({ error: "No lyrics found for this song." });
      return;
    }
    const structure = analyzeLyricsStructure(lyricsForStructure);
    res.json(structure);
  } catch (err) {
    console.error("pre-analyze-structure error:", err);
    res.status(500).json({ error: "Could not analyze song structure." });
  }
});

/**
 * POST /api/analyze-structure
 * Pre-generation endpoint: given raw lyrics text, returns a LyricsStructure analysis.
 * Allows users to see and edit section layout before the first generation request.
 */
router.post("/analyze-structure", (req, res) => {
  const { lyrics } = req.body as { lyrics?: string };
  if (!lyrics || typeof lyrics !== "string" || lyrics.trim().length < 10) {
    res.status(400).json({ error: "Provide at least 10 characters of lyrics text." });
    return;
  }
  try {
    const structure = analyzeLyricsStructure(lyrics);
    res.json(structure);
  } catch (err) {
    console.error("analyze-structure error:", err);
    res.status(500).json({ error: "Could not analyze lyrics structure." });
  }
});

// ─── Transformation presets ────────────────────────────────────────────────

interface TransformPreset {
  id: string;
  name: string;
  category: "era" | "genre" | "mood" | "energy";
  instruction: string;
}

export const TRANSFORM_PRESETS: TransformPreset[] = [
  // Era
  { id: "era-1960s", name: "1960s", category: "era", instruction: "Shift all era and decade references to 1960s: add British Invasion, Motown, psychedelic rock, vintage reverb. Remove any modern production tags." },
  { id: "era-1970s", name: "1970s", category: "era", instruction: "Shift to 1970s: add classic rock, funk groove, progressive rock, analogue warmth, FM radio sound. Remove modern/digital tags." },
  { id: "era-1980s", name: "1980s", category: "era", instruction: "Shift to 1980s: add synth-pop, gated reverb drums, glossy production, new wave. Remove acoustic/organic tags." },
  { id: "era-1990s", name: "1990s", category: "era", instruction: "Shift to 1990s: add grunge, alternative rock, lo-fi tape warmth, Britpop, 90s production. Remove modern sheen." },
  { id: "era-2000s", name: "2000s", category: "era", instruction: "Shift to 2000s: add pop-punk, emo, glossy pop, hip-hop influenced production. Remove retro warmth." },
  { id: "era-modern", name: "Modern", category: "era", instruction: "Make it contemporary 2020s: add hyperpop, modern production, crisp digital clarity, current trends. Remove vintage warmth." },
  // Genre
  { id: "genre-lofi", name: "Lo-Fi", category: "genre", instruction: "Transform into a lo-fi genre: add vinyl crackle, tape hiss, dusty samples, bedroom lo-fi, mellow keys. Remove high-energy or shiny production descriptors." },
  { id: "genre-orchestral", name: "Orchestral", category: "genre", instruction: "Transform into cinematic orchestral: add sweeping strings, brass, full orchestra, cinematic score, Hans Zimmer-inspired. Remove electronic/synth elements." },
  { id: "genre-edm", name: "EDM", category: "genre", instruction: "Transform into electronic dance: add 4/4 kick, festival drop, synthesizer leads, sidechain compression, euphoric build. Remove acoustic/organic elements." },
  { id: "genre-jazz", name: "Jazz", category: "genre", instruction: "Transform into jazz: add swing feel, walking bass, jazz harmony, brushed drums, cool jazz or bossa nova influence. Remove digital/electronic production." },
  { id: "genre-acoustic", name: "Acoustic", category: "genre", instruction: "Transform into acoustic: add fingerpicked guitar, natural room reverb, stripped-back arrangement, organic warmth. Remove electronic/synthesized elements." },
  { id: "genre-hiphop", name: "Hip-Hop", category: "genre", instruction: "Transform into hip-hop: add boom bap or trap beat, 808 bass, vinyl samples, rhythmic groove, urban production. Remove orchestral/live-band elements." },
  { id: "genre-metal", name: "Metal", category: "genre", instruction: "Transform into metal: add heavy distorted guitars, double kick drums, aggressive energy, crushing riffs. Remove gentle/soft production descriptors." },
  // Mood
  { id: "mood-darker", name: "Darker", category: "mood", instruction: "Shift mood to darker and more brooding: add minor tonality, haunting atmosphere, melancholy, shadowy undertones. Remove uplifting/bright mood descriptors." },
  { id: "mood-uplifting", name: "More Uplifting", category: "mood", instruction: "Shift mood to uplifting and hopeful: add major key brightness, soaring melodies, triumphant energy, euphoric feel. Remove dark/melancholy tags." },
  { id: "mood-aggressive", name: "More Aggressive", category: "mood", instruction: "Shift mood to aggressive and intense: add driven energy, fierce delivery, pounding rhythm, raw power. Remove calm/gentle mood descriptors." },
  { id: "mood-calmer", name: "Calmer", category: "mood", instruction: "Shift mood to calm and serene: add gentle pacing, soft dynamics, meditative stillness, peaceful atmosphere. Remove aggressive/high-energy descriptors." },
  // Energy
  { id: "energy-ramp", name: "Ramp Up", category: "energy", instruction: "Increase energy level significantly: add faster tempo feel, more drive, higher BPM tags, energetic production. Remove slow/chill descriptors." },
  { id: "energy-wind", name: "Wind Down", category: "energy", instruction: "Decrease energy level significantly: add slower tempo feel, gentle groove, relaxed pacing, chillout atmosphere. Remove high-energy/fast descriptors." },
];

/**
 * POST /api/transform
 * Lightweight transformation — takes the current styleOfMusic + negativePrompt and
 * applies a targeted delta (era shift, genre pivot, mood shift, energy change).
 * Does NOT touch lyrics. Returns only the changed fields.
 */
router.post("/suno/transform", async (req, res) => {
  const parseResult = TransformTemplateBody.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "Invalid request", details: parseResult.error.flatten() });
    return;
  }

  const { styleOfMusic, negativePrompt, transformId } = parseResult.data;
  const preset = TRANSFORM_PRESETS.find((p) => p.id === transformId);
  if (!preset) {
    res.status(400).json({ error: `Unknown transform id: ${transformId}` });
    return;
  }

  const systemPrompt = `You are a Suno.ai prompt engineer. Your job is to apply targeted transformations to an existing style prompt and negative prompt. 

Rules:
1. Only modify styleOfMusic and negativePrompt — never touch lyrics.
2. Keep styleOfMusic under 900 characters total. Trim cleanly — no half-words.
3. Keep negativePrompt between 180–199 characters total. Pad with synonyms if needed. If impossible, keep 170–199 chars.
4. Preserve all comma-separated tag structure. Output tags as comma-separated values.
5. Do not add cliché vague words like "epic", "amazing", "perfect". Be specific.
6. Return ONLY a JSON object with two fields: styleOfMusic, negativePrompt.`;

  const userPrompt = `Current styleOfMusic:
${styleOfMusic}

Current negativePrompt:
${negativePrompt}

Transformation to apply: "${preset.name}" (${preset.category})
Instruction: ${preset.instruction}

Apply the transformation and return the updated styleOfMusic and negativePrompt as a JSON object.`;

  try {
    const completion = await openai.chat.completions.create({
      model: AI_MINI_MODEL,
      max_tokens: 600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    let parsed: Record<string, string>;
    try { parsed = JSON.parse(raw) as Record<string, string>; }
    catch { parsed = {}; }

    const updatedStyle = typeof parsed.styleOfMusic === "string" ? parsed.styleOfMusic.slice(0, 900) : styleOfMusic;
    const updatedNeg = typeof parsed.negativePrompt === "string" ? parsed.negativePrompt.slice(0, 199) : negativePrompt;

    res.json({ styleOfMusic: updatedStyle, negativePrompt: updatedNeg });
  } catch (err) {
    console.error("transform error:", err);
    res.status(500).json({ error: "Transform failed" });
  }
});

/**
 * GET /api/cache/stats
 * Returns cache size and hit/miss statistics for the current process.
 * Protected by ADMIN_KEY environment variable when set.
 */
router.get("/cache/stats", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey) {
    const provided = req.headers["x-admin-key"] ?? req.query.key;
    if (provided !== adminKey) {
      res.status(401).json({ error: "Unauthorized — provide x-admin-key header or ?key= query param." });
      return;
    }
  }
  res.json(cacheStats());
});

/**
 * POST /api/multi-track
 * Generates 4 complementary Suno templates for a full arrangement:
 * lead vocal, harmony/backing, instrumental bed, rhythm/percussion.
 * Each is tuned to complement the others in key, BPM, and energy arc.
 */
router.post("/multi-track", async (req, res) => {
  const { youtubeUrl, vocalGender, energyLevel, era, mode, genres, moods, instruments, voices } =
    req.body as {
      youtubeUrl?: string;
      vocalGender?: string;
      energyLevel?: string;
      era?: string;
      mode?: string;
      genres?: string[];
      moods?: string[];
      instruments?: string[];
      voices?: string[];
    };

  if (!youtubeUrl) {
    res.status(400).json({ error: "youtubeUrl is required" });
    return;
  }

  const baseParams = {
    youtubeUrl,
    vocalGender: vocalGender as GenerateInput["vocalGender"],
    energyLevel: energyLevel as GenerateInput["energyLevel"],
    era: era as GenerateInput["era"],
    mode: mode as GenerateInput["mode"],
    genres,
    moods,
    instruments,
    voices,
  };

  const TRACK_DEFS = [
    {
      id: "lead",
      label: "Lead Vocal",
      icon: "mic",
      genreNudge: "lead vocal arrangement, main melody prominent, full production",
    },
    {
      id: "harmony",
      label: "Harmony / Backing",
      icon: "layers",
      genreNudge: "backing vocals, harmonies, supporting arrangement, complementary layers",
    },
    {
      id: "instrumental",
      label: "Instrumental Bed",
      icon: "music",
      genreNudge: "instrumental only, no vocals, rich atmospheric bed, melodic instruments",
    },
    {
      id: "rhythm",
      label: "Rhythm / Percussion",
      icon: "drum",
      genreNudge: "percussion-focused, drum patterns, groove-driven, rhythmic bed",
    },
  ] as const;

  try {
    const results = await Promise.allSettled(
      TRACK_DEFS.map((track, i) =>
        generateOneTemplate({
          ...baseParams,
          variationIndex: i + 1,
          genreNudge: track.genreNudge,
          isInstrumental: track.id === "instrumental" || track.id === "rhythm",
        })
      )
    );

    const tracks = results.map((r, i) => ({
      id: TRACK_DEFS[i].id,
      label: TRACK_DEFS[i].label,
      icon: TRACK_DEFS[i].icon,
      template: r.status === "fulfilled" ? r.value : null,
      error: r.status === "rejected" ? String((r.reason as Error).message ?? r.reason) : null,
    }));

    res.json({ tracks });
  } catch (err) {
    console.error("[multi-track] error:", err);
    res.status(500).json({ error: "Multi-track generation failed" });
  }
});

/**
 * POST /api/transition
 * Generates a bridge/transition template between two songs.
 * Analyzes both and creates a crossfade-appropriate template.
 */
router.post("/transition", async (req, res) => {
  const {
    fromUrl,
    toUrl,
    style = "smooth",
    vocalGender,
    energyLevel,
  } = req.body as {
    fromUrl?: string;
    toUrl?: string;
    style?: "smooth" | "key-change" | "genre-blend" | "breakdown";
    vocalGender?: string;
    energyLevel?: string;
  };

  if (!fromUrl || !toUrl) {
    res.status(400).json({ error: "fromUrl and toUrl are required" });
    return;
  }
  if (!isValidYouTubeUrl(fromUrl) || !isValidYouTubeUrl(toUrl)) {
    res.status(400).json({ error: "Both URLs must be valid YouTube URLs" });
    return;
  }

  const STYLE_NUDGES: Record<string, string> = {
    smooth: "seamless crossfade blend, gradual energy shift, overlapping textures",
    "key-change": "dramatic key modulation, key change transition, harmonic pivot, tension and release",
    "genre-blend": "genre fusion hybrid, blending two musical worlds, stylistic bridge",
    breakdown: "breakdown drop, stripped-back minimal section, tension build, sudden energy drop then rise",
  };

  const nudge = STYLE_NUDGES[style] ?? STYLE_NUDGES.smooth;

  const typedVocalGender = vocalGender as GenerateInput["vocalGender"];
  const typedEnergyLevel = energyLevel as GenerateInput["energyLevel"];

  try {
    const [fromResult, toResult] = await Promise.allSettled([
      generateOneTemplate({ youtubeUrl: fromUrl, vocalGender: typedVocalGender, energyLevel: typedEnergyLevel }),
      generateOneTemplate({ youtubeUrl: toUrl, vocalGender: typedVocalGender, energyLevel: typedEnergyLevel }),
    ]);

    const fromTemplate = fromResult.status === "fulfilled" ? fromResult.value : null;
    const toTemplate = toResult.status === "fulfilled" ? toResult.value : null;

    if (!fromTemplate || !toTemplate) {
      res.status(500).json({ error: "Could not analyze one or both songs" });
      return;
    }

    // Build a transition style that blends both
    const blendedStyle = `${fromTemplate.styleOfMusic.slice(0, 300)}, transition bridge, ${nudge}, ${toTemplate.styleOfMusic.slice(0, 200)}`;
    const transitionTitle = `${fromTemplate.songTitle} → ${toTemplate.songTitle} Transition`;

    // Generate a transition-specific template using the blended context
    const transitionTemplate = await generateOneTemplate({
      youtubeUrl: fromUrl,
      vocalGender: typedVocalGender,
      energyLevel: typedEnergyLevel,
      genreNudge: `transition bridge between two songs: ${nudge}. Song A: ${fromTemplate.artist} — ${fromTemplate.songTitle}. Song B: ${toTemplate.artist} — ${toTemplate.songTitle}. Create a smooth 30-second transition template.`,
    });

    res.json({
      from: { title: fromTemplate.songTitle, artist: fromTemplate.artist, template: fromTemplate },
      to: { title: toTemplate.songTitle, artist: toTemplate.artist, template: toTemplate },
      transition: {
        ...transitionTemplate,
        title: transitionTitle,
        styleOfMusic: blendedStyle.slice(0, 999),
      },
      style,
    });
  } catch (err) {
    console.error("[transition] error:", err);
    res.status(500).json({ error: "Transition generation failed" });
  }
});

/**
 * POST /api/reverse
 * Reverse-engineers a Suno template back to inferred source song and settings.
 * Useful when you have a great Suno output and want to recreate/modify the prompt.
 */
router.post("/reverse", async (req, res) => {
  const { templateText } = req.body as { templateText?: string };
  if (!templateText || templateText.trim().length < 20) {
    res.status(400).json({ error: "templateText is required (min 20 chars)" });
    return;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: AI_MINI_MODEL,
      max_tokens: 400,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a music analyst. Given a Suno.ai music generation template (style prompt, lyrics, and/or negative prompt), analyze it and reverse-engineer the likely source material and generation settings. Return a JSON object with exactly these fields:
- "inferredSong": string — most likely song title being covered/inspired (or null if unclear)
- "inferredArtist": string — most likely artist (or null if unclear)
- "inferredGenres": string[] — array of 1–4 genre names you detect in the template
- "inferredEra": string — detected decade/era (50s/60s/70s/80s/90s/2000s/2010s/modern)
- "inferredEnergy": string — one of: very chill, chill, medium, high, intense
- "inferredTempo": string — one of: ballad, slow, mid, groove, uptempo, fast, hyper
- "inferredMoods": string[] — array of 1–3 mood descriptors
- "inferredInstruments": string[] — array of prominent instruments mentioned
- "keySignature": string — detected key if mentioned (e.g. "E minor", "C major", or null)
- "bpm": number — detected BPM if mentioned (or null)
- "styleConfidence": number — confidence 0–100 in your genre/style inference
- "reasoning": string — brief explanation (max 80 words) of your analysis`,
        },
        {
          role: "user",
          content: `Analyze this Suno template:\n\n${templateText.slice(0, 3000)}`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    res.json(parsed);
  } catch (err) {
    console.error("[reverse] error:", err);
    res.status(500).json({ error: "Reverse analysis failed" });
  }
});

/**
 * POST /api/mood-to-settings
 * Converts a free-text vibe/mood description into structured style settings.
 * e.g. "rainy Sunday morning, coffee shop, slightly melancholy but hopeful"
 * → { genres, moods, energy, tempo, era, instruments, reasoning }
 */
router.post("/mood-to-settings", async (req, res) => {
  const { description } = req.body as { description?: string };
  if (!description || description.trim().length < 5) {
    res.status(400).json({ error: "description is required (min 5 chars)" });
    return;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: AI_MINI_MODEL,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a music vibe translator. Convert a user's mood/vibe description into structured Suno.ai generation settings. Return a JSON object with exactly these fields:
- "genres": string[] — array of 1–3 genre names that match the vibe
- "moods": string[] — array of 2–4 mood tags (e.g. Melancholic, Hopeful, Serene)
- "energy": string — one of: very chill, chill, medium, high, intense
- "tempo": string — one of: ballad, slow, mid, groove, uptempo, fast, hyper
- "era": string — most fitting era (50s/60s/70s/80s/90s/2000s/2010s/modern)
- "instruments": string[] — array of 2–4 instruments that fit the vibe
- "primaryGenre": string — the single most fitting genre
- "reasoning": string — brief explanation (max 60 words) of your mapping choices`,
        },
        {
          role: "user",
          content: `Vibe description: "${description.slice(0, 500)}"`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    res.json(parsed);
  } catch (err) {
    console.error("[mood-to-settings] error:", err);
    res.status(500).json({ error: "Mood translation failed" });
  }
});

export default router;
