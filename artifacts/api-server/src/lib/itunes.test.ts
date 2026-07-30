import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchITunesMetadata } from "./itunes.js";

describe("fetchITunesMetadata", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when the API has no results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ resultCount: 0, results: [] }),
    }));
    expect(await fetchITunesMetadata("Nobody", "Nothing")).toBeNull();
  });

  it("returns null on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await fetchITunesMetadata("A", "B")).toBeNull();
  });

  it("extracts genre, release year, and album from a match", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ primaryGenreName: "Pop", releaseDate: "2014-08-19T07:00:00Z", collectionName: "1989 (Deluxe Edition)" }],
      }),
    }));
    const r = await fetchITunesMetadata("Taylor Swift", "Shake It Off");
    expect(r).toEqual({ genre: "Pop", releaseYear: "2014", album: "1989 (Deluxe Edition)" });
  });

  it("returns null on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await fetchITunesMetadata("A", "B")).toBeNull();
  });

  it("ignores a malformed release date", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ primaryGenreName: "Rock", releaseDate: "not-a-date" }] }),
    }));
    const r = await fetchITunesMetadata("A", "B");
    expect(r?.genre).toBe("Rock");
    expect(r?.releaseYear).toBeUndefined();
  });
});
