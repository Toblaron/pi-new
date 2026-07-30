import { describe, it, expect } from "vitest";
import { decodeHtmlEntities } from "./htmlEntities.js";

describe("decodeHtmlEntities", () => {
  it("decodes the 5 standard named entities", () => {
    expect(decodeHtmlEntities("&amp;&lt;&gt;&quot;&#39;")).toBe(`&<>"'`);
  });

  it("decodes hex numeric character references", () => {
    expect(decodeHtmlEntities("We&#x27;re")).toBe("We're");
  });

  it("decodes decimal numeric character references", () => {
    expect(decodeHtmlEntities("really&#8212;truly&#33;")).toBe("really—truly!");
  });

  it("leaves plain text untouched", () => {
    expect(decodeHtmlEntities("Never gonna give you up")).toBe("Never gonna give you up");
  });
});
