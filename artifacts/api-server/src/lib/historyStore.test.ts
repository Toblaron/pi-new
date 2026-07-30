import { describe, it, expect, beforeEach } from "vitest";
import { db } from "./cache.js";
import { saveEntry, computeFeedbackContext, clearHistory, type HistoryEntry } from "./historyStore.js";

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

describe("computeFeedbackContext", () => {
  beforeEach(() => {
    clearHistory();
  });

  it("returns undefined with fewer than 2 rated entries", () => {
    saveEntry(makeEntry("a", 5, { genres: ["Rock"] }));
    expect(computeFeedbackContext()).toBeUndefined();
  });

  it("returns undefined when nothing is rated", () => {
    saveEntry(makeEntry("a", null));
    saveEntry(makeEntry("b", null));
    expect(computeFeedbackContext()).toBeUndefined();
  });

  it("summarizes liked genres/moods/instruments from ratings >= 4", () => {
    saveEntry(makeEntry("a", 5, { genres: ["Rock"], moods: ["Dark"], instruments: ["Guitar"] }));
    saveEntry(makeEntry("b", 4, { genres: ["Rock"], moods: ["Dark"] }));
    const ctx = computeFeedbackContext();
    expect(ctx).toBeDefined();
    expect(ctx).toContain("LIKED");
    expect(ctx).toContain("Rock");
    expect(ctx).toContain("Dark");
  });

  it("summarizes disliked genres from ratings <= 2", () => {
    saveEntry(makeEntry("a", 1, { genres: ["Phonk"] }));
    saveEntry(makeEntry("b", 2, { genres: ["Phonk"] }));
    const ctx = computeFeedbackContext();
    expect(ctx).toContain("DISLIKED");
    expect(ctx).toContain("Phonk");
  });

  it("ignores mid-range ratings (3) for both liked and disliked buckets", () => {
    saveEntry(makeEntry("a", 3, { genres: ["Jazz"] }));
    saveEntry(makeEntry("b", 3, { genres: ["Jazz"] }));
    const ctx = computeFeedbackContext();
    // Two rated entries exist, but neither qualifies as liked or disliked, so no segments to report.
    expect(ctx).toBeUndefined();
  });

  it("includes both liked and disliked segments when both exist", () => {
    saveEntry(makeEntry("a", 5, { genres: ["Rock"] }));
    saveEntry(makeEntry("b", 1, { genres: ["Phonk"] }));
    const ctx = computeFeedbackContext();
    expect(ctx).toContain("LIKED");
    expect(ctx).toContain("DISLIKED");
  });

  it("reflects the total count of rated entries", () => {
    saveEntry(makeEntry("a", 5, { genres: ["Rock"] }));
    saveEntry(makeEntry("b", 4, { genres: ["Pop"] }));
    saveEntry(makeEntry("c", 5, { genres: ["Jazz"] }));
    const ctx = computeFeedbackContext();
    expect(ctx).toContain("3 past templates");
  });
});

// Sanity check that the test DB really is isolated from the real one.
describe("test database isolation", () => {
  it("uses a throwaway SQLite file, not the real cache dir", () => {
    const row = db.prepare("PRAGMA database_list").get() as { file: string };
    expect(row.file).not.toContain("/home/dietpi/g/data/");
  });
});
