/** Hard-trim text to a char limit, breaking at the last newline boundary. */
export function trimToCharLimit(text: string, limit: number): string {
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.length <= limit) return normalized;
  const truncated = normalized.slice(0, limit);
  const lastNewline = truncated.lastIndexOf("\n");
  return lastNewline !== -1 ? truncated.slice(0, lastNewline) : "";
}

/** Hard-trim styleOfMusic to 999 chars, breaking at the last comma boundary */
export function trimStylePrompt(text: string, limit = 999): string {
  const flat = text.replace(/\r?\n/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const lastComma = cut.lastIndexOf(",");
  return lastComma > limit * 0.75 ? cut.slice(0, lastComma) : cut.trimEnd();
}
