/**
 * Condenses a full SONIC ARCHITECT style prompt (900-999 chars) down to a short,
 * plain comma-separated tag list for use with older Suno versions or other tools
 * that don't expect the full labeled-field format. Pure client-side string
 * transformation — no AI call.
 *
 * The style prompt's format (see promptBuilder.ts / the AI prompt in routes/suno.ts) is a
 * fixed sequence: [era], PRIMARY GENRE, sub-genre, BPM, key — then a series of labeled
 * fields (Neural Floor, Vocal Identity, Rhythm, Synthesis Stacks, Signal Chain, Spatial
 * Design, Dynamics, Master). The compact version keeps the header (era/genre/BPM/key,
 * always present, always comma-separated with no internal commas) plus the Vocal Identity
 * clause (label stripped), and drops the rest — the hardware/signal-chain detail that a
 * short tag list has no room for anyway.
 *
 * Verified live: the AI doesn't always literally write the field labels — sometimes it emits
 * the labeled content directly ("Neural Floor: Analog tape hiss...") and sometimes just the
 * unlabeled descriptive text at that position ("Analog tape hiss..."). When no labels are found
 * at all, this degrades gracefully to a comma-boundary truncation of the header, rather than
 * finding a "Vocal Identity" clause to append — still bounded to maxLen and still coherent, just
 * not guaranteed to specifically include vocal detail on every generation.
 */

const FIELD_LABELS = [
  "Neural Floor:",
  "Vocal Identity:",
  "Rhythm:",
  "Synthesis Stacks:",
  "Signal Chain:",
  "Spatial Design:",
  "Dynamics:",
  "Master:",
];

function firstIndexOfAny(text: string, needles: string[], from = 0): number {
  let best = -1;
  for (const needle of needles) {
    const idx = text.indexOf(needle, from);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

function trimAtCommaBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastComma = truncated.lastIndexOf(",");
  return (lastComma > maxLen * 0.5 ? truncated.slice(0, lastComma) : truncated).trim();
}

export function buildCompactStyle(styleOfMusic: string, maxLen = 200): string {
  const headerEnd = firstIndexOfAny(styleOfMusic, FIELD_LABELS);
  const header = (headerEnd === -1 ? styleOfMusic : styleOfMusic.slice(0, headerEnd))
    .replace(/,\s*$/, "")
    .trim();

  const vocalStart = styleOfMusic.indexOf("Vocal Identity:");
  let vocalClause = "";
  if (vocalStart !== -1) {
    const rest = styleOfMusic.slice(vocalStart);
    const nextLabelIdx = firstIndexOfAny(
      rest,
      FIELD_LABELS.filter((l) => l !== "Vocal Identity:"),
      "Vocal Identity:".length
    );
    vocalClause = (nextLabelIdx === -1 ? rest : rest.slice(0, nextLabelIdx))
      .replace(/^Vocal Identity:\s*/, "")
      .replace(/,\s*$/, "")
      .trim();
  }

  const combined = vocalClause ? `${header}, ${vocalClause}` : header;
  return trimAtCommaBoundary(combined, maxLen);
}
