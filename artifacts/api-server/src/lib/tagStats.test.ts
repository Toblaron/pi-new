import { describe, it, expect, beforeEach } from "vitest";
import { saveEntry, clearHistory, type HistoryEntry } from "./historyStore.js";
import { computeTagStats } from "./tagStats.js";

function makeEntry(id: string, rating: number | null, usedOptions?: unknown): HistoryEntry {
  return {
    id,
    createdAt: Date.now(),
    youtubeUrl: `https://www.youtube.com/watch?v=${id}`,
    template: { songTitle: "Test" },
    rating,
    usedOptions,
  };
}

describe("computeTagStats", () => {
  beforeEach(() => {
    clearHistory();
  });

  it("returns nothing when history is empty", () => {
    expect(computeTagStats()).toEqual([]);
  });

  it("drops tags used fewer times than minCount", () => {
    saveEntry(makeEntry("a", 5, { genres: ["Rock"] }));
    // Only 1 use — below the default minCount of 2.
    expect(computeTagStats()).toEqual([]);
  });

  it("computes an average rating per tag once minCount is met", () => {
    saveEntry(makeEntry("a", 5, { genres: ["Rock"] }));
    saveEntry(makeEntry("b", 3, { genres: ["Rock"] }));
    const stats = computeTagStats();
    const rock = stats.find((s) => s.tag === "Rock");
    expect(rock).toBeDefined();
    expect(rock!.count).toBe(2);
    expect(rock!.avgRating).toBe(4); // (5+3)/2
    expect(rock!.category).toBe("genre");
  });

  it("tracks genres, moods, and instruments as separate categories", () => {
    saveEntry(makeEntry("a", 5, { genres: ["Rock"], moods: ["Dark"], instruments: ["Guitar"] }));
    saveEntry(makeEntry("b", 4, { genres: ["Rock"], moods: ["Dark"], instruments: ["Guitar"] }));
    const stats = computeTagStats();
    expect(stats.map((s) => s.category).sort()).toEqual(["genre", "instrument", "mood"]);
  });

  it("ignores unrated entries", () => {
    saveEntry(makeEntry("a", null, { genres: ["Rock"] }));
    saveEntry(makeEntry("b", null, { genres: ["Rock"] }));
    expect(computeTagStats()).toEqual([]);
  });

  it("sorts by average rating descending", () => {
    saveEntry(makeEntry("a", 5, { genres: ["Rock"] }));
    saveEntry(makeEntry("b", 5, { genres: ["Rock"] }));
    saveEntry(makeEntry("c", 2, { genres: ["Phonk"] }));
    saveEntry(makeEntry("d", 2, { genres: ["Phonk"] }));
    const stats = computeTagStats();
    expect(stats[0].tag).toBe("Rock");
    expect(stats[1].tag).toBe("Phonk");
  });

  it("respects a custom minCount", () => {
    saveEntry(makeEntry("a", 5, { genres: ["Rock"] }));
    const stats = computeTagStats(1);
    expect(stats.find((s) => s.tag === "Rock")).toBeDefined();
  });
});
