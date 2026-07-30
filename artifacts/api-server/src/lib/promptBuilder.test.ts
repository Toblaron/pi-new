import { describe, it, expect } from "vitest";
import { trimStylePrompt, trimToCharLimit } from "./promptBuilder.js";

describe("trimStylePrompt", () => {
  it("leaves short text untouched", () => {
    expect(trimStylePrompt("short text", 999)).toBe("short text");
  });

  it("trims at the last comma boundary when possible", () => {
    const text = "a".repeat(50) + ", " + "b".repeat(50);
    const result = trimStylePrompt(text, 60);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result.endsWith(",")).toBe(false);
  });

  it("hard-trims when no comma is near the limit", () => {
    const text = "a".repeat(200);
    const result = trimStylePrompt(text, 100);
    expect(result.length).toBe(100);
  });
});

describe("trimToCharLimit", () => {
  it("leaves short text untouched", () => {
    expect(trimToCharLimit("short text", 999)).toBe("short text");
  });

  it("trims at the last newline boundary when possible", () => {
    const text = "a".repeat(50) + "\n" + "b".repeat(50);
    const result = trimToCharLimit(text, 60);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result).toBe("a".repeat(50));
  });

  it("returns empty string when no newline exists before the limit", () => {
    const text = "a".repeat(200);
    expect(trimToCharLimit(text, 100)).toBe("");
  });

  it("normalizes CRLF to LF before trimming", () => {
    const text = "line one\r\nline two\r\nline three";
    expect(trimToCharLimit(text, 999)).toBe("line one\nline two\nline three");
  });
});
