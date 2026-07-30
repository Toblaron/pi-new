/**
 * Hard-trim text to a char limit, breaking at the last newline boundary.
 *
 * Counts Unicode codepoints via Array.from, not raw .length/.slice (UTF-16 code
 * units) — for text containing emoji/supplementary-plane characters, JS .length
 * counts a surrogate pair as 2. This is the final safety-net trim applied after
 * validate_chars.py's codepoint-accurate padding/trimming; using UTF-16 units here
 * could re-clip a string Python already validated as exactly in-range.
 */
export function trimToCharLimit(text: string, limit: number): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const chars = Array.from(normalized);
  if (chars.length <= limit) return normalized;
  const truncated = chars.slice(0, limit).join("");
  const lastNewline = truncated.lastIndexOf("\n");
  return lastNewline !== -1 ? truncated.slice(0, lastNewline) : "";
}

/** Hard-trim styleOfMusic to 999 chars, breaking at the last comma boundary. Codepoint-based — see trimToCharLimit. */
export function trimStylePrompt(text: string, limit = 999): string {
  const flat = text.replace(/\r?\n/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= limit) return flat;
  const cut = chars.slice(0, limit).join("");
  const lastComma = cut.lastIndexOf(",");
  return lastComma > limit * 0.75 ? cut.slice(0, lastComma) : cut.trimEnd();
}
