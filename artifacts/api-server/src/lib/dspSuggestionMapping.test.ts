import { describe, it, expect } from "vitest";
import { mapDspInstrumentsToSuggestVocab, bpmToTempoBucket } from "./dspSuggestionMapping.js";

const INSTRUMENT_LIST = ["Piano", "Guitar", "Synth", "Strings", "Bass", "Choir", "Brass", "Drums", "Electric Guitar", "808"] as const;

describe("mapDspInstrumentsToSuggestVocab", () => {
  it("maps known YAMNet labels to the suggest vocabulary, in confidence order", () => {
    const detected = [
      { name: "Drum machine", confidence: 0.27 },
      { name: "Synthesizer", confidence: 0.22 },
      { name: "Electric guitar", confidence: 0.18 },
    ];
    expect(mapDspInstrumentsToSuggestVocab(detected, INSTRUMENT_LIST)).toEqual(["808", "Synth", "Electric Guitar"]);
  });

  it("drops labels with no mapping instead of guessing", () => {
    const detected = [{ name: "Speech", confidence: 0.9 }, { name: "Piano", confidence: 0.1 }];
    expect(mapDspInstrumentsToSuggestVocab(detected, INSTRUMENT_LIST)).toEqual(["Piano"]);
  });

  it("drops mapped targets not present in the caller's valid instrument list", () => {
    const detected = [{ name: "Tabla", confidence: 0.5 }];
    expect(mapDspInstrumentsToSuggestVocab(detected, INSTRUMENT_LIST)).toEqual([]);
  });

  it("dedupes when multiple labels map to the same target", () => {
    const detected = [
      { name: "Drum kit", confidence: 0.5 },
      { name: "Drum", confidence: 0.4 },
    ];
    expect(mapDspInstrumentsToSuggestVocab(detected, INSTRUMENT_LIST)).toEqual(["Drums"]);
  });

  it("returns an empty array for no detections", () => {
    expect(mapDspInstrumentsToSuggestVocab([], INSTRUMENT_LIST)).toEqual([]);
  });
});

describe("bpmToTempoBucket", () => {
  it("buckets known BPM ranges correctly", () => {
    expect(bpmToTempoBucket(60)).toBe("ballad");
    expect(bpmToTempoBucket(80)).toBe("slow");
    expect(bpmToTempoBucket(100)).toBe("mid");
    expect(bpmToTempoBucket(115)).toBe("groove");
    expect(bpmToTempoBucket(128)).toBe("uptempo");
    expect(bpmToTempoBucket(150)).toBe("fast");
    expect(bpmToTempoBucket(175)).toBe("hyper");
  });

  it("handles boundary values", () => {
    expect(bpmToTempoBucket(70)).toBe("slow");
    expect(bpmToTempoBucket(160)).toBe("hyper");
  });
});
