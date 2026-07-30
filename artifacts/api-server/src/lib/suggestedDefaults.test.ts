import { describe, it, expect } from "vitest";
import { computeSuggestedDefaults } from "./suggestedDefaults.js";

describe("computeSuggestedDefaults", () => {
  it("returns an empty-ish result when nothing is provided", () => {
    const r = computeSuggestedDefaults({});
    expect(r.energy).toBeUndefined();
    expect(r.tempo).toBeUndefined();
    expect(r.era).toBeUndefined();
    expect(r.sources).toEqual({});
  });

  it.each([
    [150, "intense", "hyper"],
    [125, "high", "uptempo"],
    [100, "medium", "groove"],
    [70, "chill", "slow"],
    [50, "very chill", "ballad"],
  ])("maps BPM %i to energy=%s tempo=%s", (bpm, energy, tempo) => {
    const r = computeSuggestedDefaults({ bpm });
    expect(r.energy).toBe(energy);
    expect(r.tempo).toBe(tempo);
  });

  it("maps release year to era", () => {
    expect(computeSuggestedDefaults({ releaseYear: "1985" }).era).toBe("80s");
    expect(computeSuggestedDefaults({ releaseYear: "2023" }).era).toBe("modern");
  });

  it("ignores unparseable release years", () => {
    expect(computeSuggestedDefaults({ releaseYear: "not-a-year" }).era).toBeUndefined();
  });

  it("suggests a genre hint for a non-English language", () => {
    const r = computeSuggestedDefaults({ language: "Korean" });
    expect(r.languageGenreHint).toBe("K-Pop");
  });

  it("does not suggest a genre hint for English", () => {
    const r = computeSuggestedDefaults({ language: "English" });
    expect(r.languageGenreHint).toBeUndefined();
  });

  it("extracts instrument hints from a description", () => {
    const r = computeSuggestedDefaults({ description: "Featuring acoustic guitar and piano" });
    expect(r.instrumentHints).toEqual(expect.arrayContaining(["Acoustic Guitar", "Piano"]));
  });

  it("caps instrument hints at 5", () => {
    const r = computeSuggestedDefaults({
      description: "guitar piano synth violin cello drums bass flute saxophone",
    });
    expect(r.instrumentHints?.length).toBeLessThanOrEqual(5);
  });
});
