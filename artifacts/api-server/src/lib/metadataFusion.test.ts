import { describe, it, expect } from "vitest";
import { fuseMetadata } from "./metadataFusion.js";

describe("fuseMetadata", () => {
  it("returns no sources and no BPM when nothing is provided", () => {
    const r = fuseMetadata({});
    expect(r.sources).toEqual([]);
    expect(r.bpm).toBeUndefined();
    expect(r.bpmConfident).toBe(false);
  });

  it("uses a single BPM candidate but marks it unconfident", () => {
    const r = fuseMetadata({ theaudiodb: { bpm: 120 } });
    expect(r.bpm).toBe(120);
    expect(r.bpmConfident).toBe(false);
  });

  it("marks BPM confident when two sources agree within ±2", () => {
    const r = fuseMetadata({
      theaudiodb: { bpm: 120 },
      deezer: { bpm: 121 },
    });
    expect(r.bpmConfident).toBe(true);
    expect(r.bpm).toBe(121); // rounded average of 120 and 121
  });

  it("does not mark BPM confident when sources disagree", () => {
    const r = fuseMetadata({
      theaudiodb: { bpm: 120 },
      deezer: { bpm: 60 }, // half-time misdetection
    });
    expect(r.bpmConfident).toBe(false);
  });

  it("treats deezer bpm of 0 as absent, not a candidate", () => {
    const r = fuseMetadata({ deezer: { bpm: 0, releaseYear: "2003" } });
    expect(r.bpm).toBeUndefined();
    expect(r.sources).toContain("deezer");
  });

  it("uses deezer releaseYear only as a fallback when musicbrainz has none", () => {
    const withMb = fuseMetadata({
      mb: { releaseYear: "1999" },
      deezer: { releaseYear: "2003" },
    });
    expect(withMb.releaseYear).toBe("1999");

    const withoutMb = fuseMetadata({ deezer: { releaseYear: "2003" } });
    expect(withoutMb.releaseYear).toBe("2003");
  });

  it("splits last.fm tags between moods and generic tags", () => {
    // Note: fetchLastFmTags (lastfm.ts) is responsible for filtering out noise tags like
    // "seen live" or bare numbers before they reach fuseMetadata — this only tests the
    // mood-word/generic-tag split on whatever it receives.
    const r = fuseMetadata({ lastfm: ["melancholic", "rock"] });
    expect(r.moods).toContain("melancholic");
    expect(r.tags).toContain("rock");
    expect(r.tags).not.toContain("melancholic");
  });

  it("deduplicates genres case-insensitively across sources", () => {
    const r = fuseMetadata({
      mb: { genres: ["Rock"] },
      discogs: { genres: ["rock"], styles: [] },
      theaudiodb: { genre: "ROCK" },
    });
    expect(r.genres.filter((g) => g === "rock").length).toBe(1);
  });

  it("lists every contributing source", () => {
    const r = fuseMetadata({
      mb: { releaseYear: "2003" },
      lastfm: ["rock"],
      discogs: { genres: [], styles: [] },
      theaudiodb: { genre: "rock" },
      deezer: { bpm: 120 },
      itunes: { genre: "pop" },
    });
    expect(r.sources).toEqual(
      expect.arrayContaining(["musicbrainz", "lastfm", "discogs", "theaudiodb", "deezer", "itunes"]),
    );
  });

  it("uses itunes genre and releaseYear as a fallback", () => {
    const r = fuseMetadata({ itunes: { genre: "Pop", releaseYear: "2014" } });
    expect(r.genres).toContain("pop");
    expect(r.releaseYear).toBe("2014");
  });

  it("prefers musicbrainz releaseYear over itunes", () => {
    const r = fuseMetadata({
      mb: { releaseYear: "1999" },
      itunes: { releaseYear: "2014" },
    });
    expect(r.releaseYear).toBe("1999");
  });
});
