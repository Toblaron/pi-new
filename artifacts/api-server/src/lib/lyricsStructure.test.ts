import { describe, it, expect } from "vitest";
import { analyzeLyricsStructure } from "./lyricsStructure.js";

describe("analyzeLyricsStructure", () => {
  it("returns an empty structure for blank input", () => {
    const r = analyzeLyricsStructure("");
    expect(r.sections).toEqual([]);
    expect(r.totalSections).toBe(0);
    expect(r.hasTaggedStructure).toBe(false);
  });

  it("parses [Tag] structured lyrics into labeled sections", () => {
    const lyrics = `[Verse 1]\nLine one\nLine two\n\n[Chorus]\nHook line\nHook line again`;
    const r = analyzeLyricsStructure(lyrics);
    expect(r.hasTaggedStructure).toBe(true);
    expect(r.sections.map((s) => s.label)).toEqual(["Verse 1", "Chorus"]);
    expect(r.sections[1].isHook).toBe(true);
    expect(r.sections[0].isHook).toBe(false);
  });

  it("falls back to heuristic block labeling for untagged lyrics", () => {
    const lyrics = `First block line one\nFirst block line two\n\nSecond block line one`;
    const r = analyzeLyricsStructure(lyrics);
    expect(r.hasTaggedStructure).toBe(false);
    expect(r.sections.length).toBe(2);
    expect(r.sections[0].label).toBe("Intro");
    expect(r.sections[1].label).toBe("Verse 1");
  });

  it("detects repeated chorus blocks as hook repetitions", () => {
    const lyrics = `[Verse 1]\nSome unique line\n\n[Chorus]\nSame hook line\n\n[Verse 2]\nAnother unique line\n\n[Chorus]\nSame hook line`;
    const r = analyzeLyricsStructure(lyrics);
    expect(r.hookRepetitions).toBeGreaterThanOrEqual(2);
  });

  it("scores sentiment based on positive/negative word counts", () => {
    const happy = analyzeLyricsStructure("[Verse 1]\nlove joy happy beautiful light");
    const sad = analyzeLyricsStructure("[Verse 1]\nsad pain cry broken lost");
    expect(happy.sections[0].sentiment).toBeGreaterThan(0);
    expect(sad.sections[0].sentiment).toBeLessThan(0);
  });

  it("normalizes numbered verse labels", () => {
    const r = analyzeLyricsStructure("[Verse 2 - building tension]\nSome line");
    expect(r.sections[0].label).toBe("Verse 2");
  });
});
