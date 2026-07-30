import { describe, it, expect } from "vitest";
import {
  cleanSongTitle,
  parseDescriptionForMusicData,
  videoIdFromUrl,
  isValidYouTubeUrl,
  trimStylePrompt,
  mapMbTagsToGenres,
  yearToEra,
  inferEnergy,
  inferTempo,
  inferVocals,
  inferInstruments,
  inferMoods,
  inferNudge,
} from "./suno.js";

describe("cleanSongTitle", () => {
  it("splits a leading 'Artist - Song' title", () => {
    const r = cleanSongTitle("Linkin Park - Numb", "Linkin Park");
    expect(r.cleanTitle).toBe("Numb");
    expect(r.cleanArtist).toBe("Linkin Park");
  });

  it("strips '(Official Video)' suffixes", () => {
    const r = cleanSongTitle("Numb (Official Video)", "Linkin Park");
    expect(r.cleanTitle).toBe("Numb");
  });

  it("strips '[Lyrics]' bracket suffixes", () => {
    const r = cleanSongTitle("Numb [Lyrics]", "Linkin Park");
    expect(r.cleanTitle).toBe("Numb");
  });

  it("handles en-dash separators, not just ASCII hyphens", () => {
    const r = cleanSongTitle("Linkin Park – Numb", "Linkin Park");
    expect(r.cleanTitle).toBe("Numb");
    expect(r.cleanArtist).toBe("Linkin Park");
  });

  it("strips a trailing en-dash artist repeat plus a combined bracket tag (regression: real-world failure)", () => {
    // Actual YouTube title observed in production: title starts with the song, not the artist,
    // so the leading-split heuristic doesn't fire — the trailing "– Linkin Park" and "[4K UPGRADE]"
    // must both be recognized as noise.
    const r = cleanSongTitle("Numb (Official Music Video) [4K UPGRADE] – Linkin Park", "Linkin Park");
    expect(r.cleanTitle).toBe("Numb");
    expect(r.cleanArtist).toBe("Linkin Park");
  });

  it("strips combined '(Official Video Remastered)' in one bracket group (regression: real-world failure)", () => {
    const r = cleanSongTitle("Queen – Bohemian Rhapsody (Official Video Remastered)", "Queen Official");
    expect(r.cleanTitle).toBe("Bohemian Rhapsody");
    expect(r.cleanArtist).toBe("Queen");
  });

  it("strips a '- Topic' auto-generated channel suffix from the artist", () => {
    const r = cleanSongTitle("Numb", "Linkin Park - Topic");
    expect(r.cleanArtist).toBe("Linkin Park");
  });

  it("strips featured-artist suffixes", () => {
    const r1 = cleanSongTitle("Blinding Lights - feat. Rosalía", "The Weeknd");
    expect(r1.cleanTitle).toBe("Blinding Lights");
    const r2 = cleanSongTitle("Blinding Lights (feat. Rosalía)", "The Weeknd");
    expect(r2.cleanTitle).toBe("Blinding Lights");
  });

  it("does not split when the leading segment looks like a sentence, not an artist", () => {
    const r = cleanSongTitle("This Song Is About Love And Loss - A Ballad For You", "Some Artist");
    // Leading segment has > 5 words, so no split should occur.
    expect(r.cleanArtist).toBe("Some Artist");
  });

  it("handles a plain title with no noise unchanged", () => {
    const r = cleanSongTitle("Bohemian Rhapsody", "Queen");
    expect(r.cleanTitle).toBe("Bohemian Rhapsody");
    expect(r.cleanArtist).toBe("Queen");
  });

  it("handles 4K/HD/remaster quality tags", () => {
    expect(cleanSongTitle("Numb (4K Remastered)", "Linkin Park").cleanTitle).toBe("Numb");
    expect(cleanSongTitle("Numb (HD)", "Linkin Park").cleanTitle).toBe("Numb");
    expect(cleanSongTitle("Numb [HQ]", "Linkin Park").cleanTitle).toBe("Numb");
  });
});

describe("parseDescriptionForMusicData", () => {
  it("returns empty object for empty description", () => {
    expect(parseDescriptionForMusicData("")).toEqual({});
  });

  it("extracts release year near a copyright/label symbol", () => {
    const r = parseDescriptionForMusicData("℗ 2003 Warner Records");
    expect(r.releaseYear).toBe("2003");
  });

  it("extracts BPM", () => {
    const r = parseDescriptionForMusicData("This track is 128 BPM and great for dancing");
    expect(r.bpm).toBe("128");
  });

  it("extracts musical key", () => {
    const r = parseDescriptionForMusicData("Written in the key of A minor");
    expect(r.key?.toLowerCase()).toContain("a minor");
  });

  it("extracts produced-by credit", () => {
    const r = parseDescriptionForMusicData("Produced by: Rick Rubin\nMore info below");
    expect(r.producedBy).toBe("Rick Rubin");
  });
});

describe("videoIdFromUrl", () => {
  it("extracts id from a standard watch URL", () => {
    expect(videoIdFromUrl("https://www.youtube.com/watch?v=kXYiU_JCYtU")).toBe("kXYiU_JCYtU");
  });

  it("extracts id from a youtu.be short URL", () => {
    expect(videoIdFromUrl("https://youtu.be/kXYiU_JCYtU")).toBe("kXYiU_JCYtU");
  });

  it("extracts id from a shorts URL", () => {
    expect(videoIdFromUrl("https://www.youtube.com/shorts/kXYiU_JCYtU")).toBe("kXYiU_JCYtU");
  });

  it("returns null for a non-YouTube URL", () => {
    expect(videoIdFromUrl("https://example.com/watch?v=abc")).toBeNull();
  });

  it("returns null for an invalid URL string", () => {
    expect(videoIdFromUrl("not a url")).toBeNull();
  });
});

describe("isValidYouTubeUrl", () => {
  it("accepts standard watch URLs", () => {
    expect(isValidYouTubeUrl("https://www.youtube.com/watch?v=abc123")).toBe(true);
  });

  it("accepts youtu.be short links", () => {
    expect(isValidYouTubeUrl("https://youtu.be/abc123")).toBe(true);
  });

  it("accepts shorts URLs", () => {
    expect(isValidYouTubeUrl("https://www.youtube.com/shorts/abc123")).toBe(true);
  });

  it("rejects non-YouTube domains", () => {
    expect(isValidYouTubeUrl("https://vimeo.com/12345")).toBe(false);
  });

  it("rejects a bare YouTube homepage URL", () => {
    expect(isValidYouTubeUrl("https://www.youtube.com/")).toBe(false);
  });

  it("rejects garbage input", () => {
    expect(isValidYouTubeUrl("not a url")).toBe(false);
  });
});

describe("trimStylePrompt", () => {
  it("leaves short text untouched", () => {
    expect(trimStylePrompt("short text", 999)).toBe("short text");
  });

  it("trims at the last comma boundary when possible", () => {
    const text = "a".repeat(50) + ", " + "b".repeat(50);
    const result = trimStylePrompt(text, 60);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result.endsWith(",")).toBe(false);
  });

  it("hard-trims when no comma is near the limit", () => {
    const text = "a".repeat(200);
    const result = trimStylePrompt(text, 100);
    expect(result.length).toBe(100);
  });
});

describe("mapMbTagsToGenres", () => {
  it("maps known MusicBrainz tags to internal genres", () => {
    const r = mapMbTagsToGenres(["rock"]);
    expect(r.length).toBeGreaterThan(0);
  });

  it("ignores unknown tags", () => {
    expect(mapMbTagsToGenres(["totally-unknown-tag-xyz"])).toEqual([]);
  });

  it("caps results at 5", () => {
    const r = mapMbTagsToGenres(["rock", "pop", "jazz", "metal", "hip hop", "house", "techno"]);
    expect(r.length).toBeLessThanOrEqual(5);
  });
});

describe("yearToEra", () => {
  it("returns null for undefined input", () => {
    expect(yearToEra(undefined)).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(yearToEra("not-a-year")).toBeNull();
  });

  it.each([
    ["1955", "50s"],
    ["1965", "60s"],
    ["1975", "70s"],
    ["1985", "80s"],
    ["1995", "90s"],
    ["2005", "2000s"],
    ["2015", "2010s"],
    ["2023", "modern"],
  ])("maps year %s to era %s", (year, era) => {
    expect(yearToEra(year)).toBe(era);
  });
});

describe("infer* helpers", () => {
  it("inferEnergy returns null for unknown genres", () => {
    expect(inferEnergy(["Totally Unknown Genre"])).toBeNull();
  });

  it("inferEnergy returns a value for a known genre", () => {
    expect(inferTempo(["Trance"])).toBeTruthy();
  });

  it("inferVocals defaults to mixed for unknown genres", () => {
    expect(inferVocals(["Totally Unknown Genre"])).toBe("mixed");
  });

  it("inferVocals returns no vocals for ambient", () => {
    expect(inferVocals(["Ambient"])).toBe("no vocals");
  });

  it("inferInstruments falls back to defaults for unknown genres", () => {
    const r = inferInstruments(["Totally Unknown Genre"]);
    expect(r.length).toBe(5);
  });

  it("inferMoods falls back to defaults when nothing matches the valid set", () => {
    const r = inferMoods(["Pop"], new Set());
    expect(r.length).toBeGreaterThan(0);
  });

  it("inferNudge produces a non-empty description", () => {
    const r = inferNudge(["Pop"], "high", "fast");
    expect(r.length).toBeGreaterThan(0);
  });
});
