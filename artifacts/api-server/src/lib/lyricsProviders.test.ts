import { describe, it, expect } from "vitest";
import { parse as parseHtml } from "node-html-parser";
import { detectLanguage, parseGeniusContainer } from "./lyricsProviders.js";

describe("parseGeniusContainer", () => {
  it("strips data-exclude-from-selection chrome (contributors/translations widget)", () => {
    // Real Genius pages nest a "N Contributors" + translations-language dropdown inside the
    // lyrics container, marked data-exclude-from-selection="true". Regression test for a bug
    // where this leaked into scraped lyrics, contaminating both the text sent to the AI and
    // language detection (translation language names read as the song's actual language).
    const html = `
      <div data-lyrics-container="true">
        <div data-exclude-from-selection="true">
          <button>268 Contributors</button>
          <span>Русский (Russian)</span>
          <span>한국어</span>
        </div>
        [Intro]<br>Desert you
      </div>
    `;
    const container = parseHtml(html).querySelector("[data-lyrics-container='true']")!;
    const text = parseGeniusContainer(container);
    expect(text).not.toContain("Contributors");
    expect(text).not.toContain("Русский");
    expect(text).not.toContain("한국어");
    expect(text).toContain("[Intro]");
    expect(text).toContain("Desert you");
  });

  it("decodes numeric HTML entities (hex and decimal), not just named ones", () => {
    // Genius emits &#x27; for apostrophes, which the original named-entity-only replace list
    // (&amp; &lt; &gt; &quot; &#39; &apos;) did not cover — literal "&#x27;" leaked into lyrics.
    const html = `<div data-lyrics-container="true">We&#x27;re no strangers&#8212;really&#33;</div>`;
    const container = parseHtml(html).querySelector("[data-lyrics-container='true']")!;
    const text = parseGeniusContainer(container);
    expect(text).toBe("We're no strangers—really!");
  });
});

describe("detectLanguage", () => {
  it("defaults to English for short or ASCII-only text", () => {
    expect(detectLanguage("")).toBe("English");
    expect(detectLanguage("hi")).toBe("English");
    expect(detectLanguage("We're no strangers to love, you know the rules")).toBe("English");
  });

  it("detects non-Latin scripts", () => {
    expect(detectLanguage("이것은 한국어 가사입니다 정말로 그렇습니다 확실히")).toBe("Korean");
    expect(detectLanguage("Это русский текст песни, действительно длинный")).toBe("Russian");
  });
});
