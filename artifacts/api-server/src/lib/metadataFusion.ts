// Local definition to avoid circular imports with suno route
export interface MusicBrainzData {
  releaseYear?: string;
  genres?: string[];
  label?: string;
  album?: string;
  isrc?: string;
}

export interface FusedMetadata {
  genres: string[];       // merged, deduplicated
  moods: string[];        // from lastfm/theaudiodb
  bpm?: number;           // consensus BPM
  bpmConfident: boolean;  // true if 2+ sources agree within ±2
  key?: string;           // highest-confidence key
  releaseYear?: string;
  tags: string[];         // all extra tags (mb tags + lastfm tags + discogs styles)
  sources: string[];      // which sources contributed data
}

// Known mood words used to filter lastfm tags
const MOOD_WORDS = new Set([
  "melancholic", "melancholy", "sad", "happy", "euphoric", "dark", "romantic",
  "aggressive", "chill", "relaxing", "relaxed", "energetic", "upbeat", "mellow",
  "dreamy", "angry", "peaceful", "nostalgic", "uplifting", "intense", "calm",
  "haunting", "joyful", "somber", "cheerful", "gloomy", "hopeful", "anxious",
  "bittersweet", "emotional", "passionate", "sentimental", "dramatic", "epic",
  "melancholia", "eerie", "moody", "groovy", "hypnotic", "meditative",
]);

interface FuseMetadataSources {
  mb?: MusicBrainzData;
  lastfm?: string[] | null;
  discogs?: { genres: string[]; styles: string[] } | null;
  theaudiodb?: { genre?: string; mood?: string; style?: string; bpm?: number } | null;
  bpmCandidates?: Array<{ value: number; source: string }>;
}

function deduplicateLower(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = item.toLowerCase().trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function findBpmConsensus(
  candidates: Array<{ value: number; source: string }>,
): { bpm?: number; confident: boolean } {
  if (candidates.length === 0) return { confident: false };
  if (candidates.length === 1) return { bpm: candidates[0].value, confident: false };

  // Check if any 2+ candidates agree within ±2 bpm
  for (let i = 0; i < candidates.length; i++) {
    const agreements = candidates.filter((c) => Math.abs(c.value - candidates[i].value) <= 2);
    if (agreements.length >= 2) {
      // Return the average of agreeing values
      const avg = Math.round(agreements.reduce((sum, c) => sum + c.value, 0) / agreements.length);
      return { bpm: avg, confident: true };
    }
  }

  // No consensus — return first candidate but not confident
  return { bpm: candidates[0].value, confident: false };
}

export function fuseMetadata(sources: FuseMetadataSources): FusedMetadata {
  const contributingSources: string[] = [];
  const allGenres: string[] = [];
  const allMoods: string[] = [];
  const allTags: string[] = [];
  const bpmCandidates: Array<{ value: number; source: string }> = sources.bpmCandidates ?? [];
  let releaseYear: string | undefined;

  // MusicBrainz
  if (sources.mb) {
    contributingSources.push("musicbrainz");
    if (sources.mb.genres) allGenres.push(...sources.mb.genres);
    if (sources.mb.releaseYear) releaseYear = sources.mb.releaseYear;
  }

  // Last.fm tags
  if (sources.lastfm && sources.lastfm.length > 0) {
    contributingSources.push("lastfm");
    for (const tag of sources.lastfm) {
      const normalized = tag.toLowerCase().trim();
      if (MOOD_WORDS.has(normalized)) {
        allMoods.push(normalized);
      } else {
        allTags.push(normalized);
      }
    }
  }

  // Discogs
  if (sources.discogs) {
    contributingSources.push("discogs");
    allGenres.push(...sources.discogs.genres);
    // Discogs styles go into tags
    allTags.push(...sources.discogs.styles);
  }

  // TheAudioDB
  if (sources.theaudiodb) {
    contributingSources.push("theaudiodb");
    if (sources.theaudiodb.genre) allGenres.push(sources.theaudiodb.genre);
    if (sources.theaudiodb.mood) allMoods.push(sources.theaudiodb.mood);
    if (sources.theaudiodb.style) allTags.push(sources.theaudiodb.style);
    if (sources.theaudiodb.bpm && sources.theaudiodb.bpm > 0) {
      bpmCandidates.push({ value: sources.theaudiodb.bpm, source: "theaudiodb" });
    }
  }

  // BPM consensus
  const { bpm, confident: bpmConfident } = findBpmConsensus(bpmCandidates);

  const genres = deduplicateLower(allGenres).slice(0, 8);
  const moods = deduplicateLower(allMoods);
  const tags = deduplicateLower(allTags).slice(0, 10);

  return {
    genres,
    moods,
    bpm,
    bpmConfident,
    releaseYear,
    tags,
    sources: [...new Set(contributingSources)],
  };
}
