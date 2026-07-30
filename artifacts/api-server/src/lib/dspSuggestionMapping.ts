/**
 * Maps real DSP measurements (analyze_audio.py's YAMNet instrument tags, measured BPM) onto
 * /api/suggest's constrained vocabulary (INSTRUMENT_LIST, TEMPO_ENUM) — used only when a video
 * already has dsp-measured data cached from a prior generation, so a real measurement can win
 * over an AI guess. Never triggers new analysis; purely a mapping over already-cached data.
 */

// YAMNet's raw AudioSet labels -> /suggest's INSTRUMENT_LIST vocabulary. Not 1:1 — several
// AudioSet labels have no reasonable equivalent in the UI's fixed instrument list and are
// intentionally omitted rather than force-mapped to something misleading.
const INSTRUMENT_LABEL_MAP: Record<string, string> = {
  "Guitar": "Guitar",
  "Electric guitar": "Electric Guitar",
  "Acoustic guitar": "Acoustic Guitar",
  "Bass guitar": "Bass",
  "Steel guitar, slide guitar": "Pedal Steel",
  "Ukulele": "Ukulele",
  "Banjo": "Banjo",
  "Mandolin": "Mandolin",
  "Piano": "Piano",
  "Electric piano": "Piano",
  "Organ": "Organ",
  "Electronic organ": "Organ",
  "Hammond organ": "Organ",
  "Synthesizer": "Synth",
  "Drum machine": "808",
  "Percussion": "Drums",
  "Drum kit": "Drums",
  "Drum": "Drums",
  "Tabla": "Tabla",
  "Congas": "Congas",
  "Violin, fiddle": "Violin",
  "Cello": "Cello",
  "Double bass": "Bass",
  "String section": "Strings",
  "Trumpet": "Trumpet",
  "Trombone": "Trombone",
  "Brass instrument": "Brass",
  "French horn": "French Horn",
  "Saxophone": "Saxophone",
  "Clarinet": "Clarinet",
  "Flute": "Flute",
  "Bagpipes": "Bagpipes",
  "Harmonica": "Harmonica",
  "Accordion": "Accordion",
  "Harp": "Harp",
  "Choir": "Choir",
  "Vibraphone": "Vibraphone",
  "Marimba, xylophone": "Marimba",
  "Glockenspiel": "Glockenspiel",
};

/**
 * Maps DSP-detected instrument labels (already sorted by confidence, from AudioFeatures.instruments)
 * to /suggest's INSTRUMENT_LIST vocabulary, deduped, in confidence order. Labels with no mapping
 * are silently dropped rather than guessed at.
 */
export function mapDspInstrumentsToSuggestVocab(
  detected: Array<{ name: string; confidence: number }>,
  validInstruments: readonly string[],
): string[] {
  const validSet = new Set(validInstruments);
  const mapped: string[] = [];
  const seen = new Set<string>();
  for (const { name } of detected) {
    const target = INSTRUMENT_LABEL_MAP[name];
    if (target && validSet.has(target) && !seen.has(target)) {
      mapped.push(target);
      seen.add(target);
    }
  }
  return mapped;
}

/**
 * Buckets a measured BPM into /suggest's TEMPO_ENUM. Boundaries follow common genre/tempo
 * convention (ballad <70, house/uptempo ~120-139, drum&bass/hardcore 160+) — approximate by
 * nature, same as any BPM-to-descriptor mapping.
 */
export function bpmToTempoBucket(bpm: number): "ballad" | "slow" | "mid" | "groove" | "uptempo" | "fast" | "hyper" {
  if (bpm < 70) return "ballad";
  if (bpm < 90) return "slow";
  if (bpm < 110) return "mid";
  if (bpm < 120) return "groove";
  if (bpm < 140) return "uptempo";
  if (bpm < 160) return "fast";
  return "hyper";
}
