import { describe, it, expect } from "vitest";
import {
  mapMbTagsToGenres,
  yearToEra,
  inferEnergy,
  inferTempo,
  inferVocals,
  inferInstruments,
  inferMoods,
  inferNudge,
} from "./genreInference.js";

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
