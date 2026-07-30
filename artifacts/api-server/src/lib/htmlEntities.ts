/**
 * Decodes HTML entities in scraped/XML text: the 5 standard named entities plus numeric
 * character references (decimal &#NNN; and hex &#xHHH;) — sources like Genius and YouTube's
 * page HTML commonly emit punctuation (apostrophes, em-dashes, curly quotes) as numeric refs,
 * which a named-entity-only replace list leaves as literal "&#x27;"-style text.
 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}
