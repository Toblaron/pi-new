import { describe, it, expect } from "vitest";
import { computeFingerprint } from "./fingerprint.js";

describe("computeFingerprint", () => {
  it("returns all axes clamped to 0–10 for empty input", () => {
    const r = computeFingerprint({});
    for (const axis of [
      "energy",
      "tempoFeel",
      "vocalPresence",
      "instrumentalComplexity",
      "eraAuthenticity",
      "moodValence",
      "genrePurity",
    ] as const) {
      expect(r[axis]).toBeGreaterThanOrEqual(0);
      expect(r[axis]).toBeLessThanOrEqual(10);
    }
  });

  it("gives high-BPM tracks higher energy than low-BPM tracks", () => {
    const fast = computeFingerprint({ audioFeatures: { bpm: 175, key: "C major", timeSignature: "4/4", source: "ai-knowledge", confidence: 0.5 } });
    const slow = computeFingerprint({ audioFeatures: { bpm: 55, key: "C major", timeSignature: "4/4", source: "ai-knowledge", confidence: 0.5 } });
    expect(fast.energy).toBeGreaterThan(slow.energy);
    expect(fast.tempoFeel).toBeGreaterThan(slow.tempoFeel);
  });

  it("zeroes vocal presence for instrumental tracks", () => {
    const r = computeFingerprint({ isInstrumental: true });
    expect(r.vocalPresence).toBe(0);
  });

  it("zeroes vocal presence when vocalGender is 'no vocals'", () => {
    const r = computeFingerprint({ vocalGender: "no vocals" });
    expect(r.vocalPresence).toBe(0);
  });

  it("major keys push mood valence up, minor keys push it down", () => {
    const major = computeFingerprint({ audioFeatures: { bpm: 100, key: "C major", timeSignature: "4/4", source: "ai-knowledge", confidence: 0.5 } });
    const minor = computeFingerprint({ audioFeatures: { bpm: 100, key: "C minor", timeSignature: "4/4", source: "ai-knowledge", confidence: 0.5 } });
    expect(major.moodValence).toBeGreaterThan(minor.moodValence);
  });

  it("more MusicBrainz genres lowers genre purity", () => {
    const pure = computeFingerprint({ musicBrainzGenres: ["rock"] });
    const mixed = computeFingerprint({ musicBrainzGenres: ["rock", "jazz", "funk", "soul", "pop"] });
    expect(pure.genrePurity).toBeGreaterThan(mixed.genrePurity);
  });

  it("passes through identifying metadata unchanged", () => {
    const r = computeFingerprint({ videoId: "abc123", songTitle: "Numb", artist: "Linkin Park" });
    expect(r.videoId).toBe("abc123");
    expect(r.songTitle).toBe("Numb");
    expect(r.artist).toBe("Linkin Park");
  });
});
