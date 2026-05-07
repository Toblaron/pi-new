import { Router, type IRouter } from "express";
import {
  saveEntry,
  searchEntries,
  listCollections,
  updateCollection,
  updateRating,
  deleteEntry,
  clearHistory,
  saveShareLink,
  getShareLink,
  type HistoryEntry,
} from "../lib/historyStore.js";

const router: IRouter = Router();

/**
 * GET /api/history
 * Returns history entries with optional search/filter/sort.
 *
 * Query params:
 *   limit=50        max 200
 *   offset=0
 *   search=TEXT     LIKE match on song_title or artist
 *   rating=N        exact rating match
 *   minRating=N     minimum rating
 *   collection=NAME filter by collection
 *   sortBy=created_at|rating|quality_score
 *   sortDir=asc|desc
 *
 * Response: { entries, total }
 */
router.get("/history", (req, res) => {
  const rawLimit = parseInt(String(req.query.limit ?? "50"), 10);
  const limit = Math.min(Math.max(isNaN(rawLimit) ? 50 : rawLimit, 1), 200);

  const rawOffset = parseInt(String(req.query.offset ?? "0"), 10);
  const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

  const search = req.query.search ? String(req.query.search) : undefined;

  const rawRating = req.query.rating !== undefined ? parseInt(String(req.query.rating), 10) : undefined;
  const rating = rawRating !== undefined && !isNaN(rawRating) ? rawRating : undefined;

  const rawMinRating = req.query.minRating !== undefined ? parseInt(String(req.query.minRating), 10) : undefined;
  const minRating = rawMinRating !== undefined && !isNaN(rawMinRating) ? rawMinRating : undefined;

  const collection = req.query.collection ? String(req.query.collection) : undefined;

  const allowedSortBy = ["created_at", "rating", "quality_score"] as const;
  type SortBy = (typeof allowedSortBy)[number];
  const sortByRaw = String(req.query.sortBy ?? "");
  const sortBy = (allowedSortBy as readonly string[]).includes(sortByRaw)
    ? (sortByRaw as SortBy)
    : undefined;

  const sortDir = req.query.sortDir === "asc" ? "asc" as const : req.query.sortDir === "desc" ? "desc" as const : undefined;

  try {
    const result = searchEntries({ limit, offset, search, rating, minRating, collection, sortBy, sortDir });
    res.json(result);
  } catch (err) {
    console.error("[history] list error:", err);
    res.status(500).json({ error: "Failed to load history" });
  }
});

/**
 * GET /api/history/export
 * Export history as a JSON file download.
 * Accepts the same query params as GET /history (search, collection, rating, etc.).
 * Response: attachment JSON { exportedAt, count, entries }
 */
router.get("/history/export", (req, res) => {
  const rawLimit = parseInt(String(req.query.limit ?? "200"), 10);
  const limit = Math.min(Math.max(isNaN(rawLimit) ? 200 : rawLimit, 1), 200);

  const rawOffset = parseInt(String(req.query.offset ?? "0"), 10);
  const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

  const search = req.query.search ? String(req.query.search) : undefined;

  const rawRating = req.query.rating !== undefined ? parseInt(String(req.query.rating), 10) : undefined;
  const rating = rawRating !== undefined && !isNaN(rawRating) ? rawRating : undefined;

  const rawMinRating = req.query.minRating !== undefined ? parseInt(String(req.query.minRating), 10) : undefined;
  const minRating = rawMinRating !== undefined && !isNaN(rawMinRating) ? rawMinRating : undefined;

  const collection = req.query.collection ? String(req.query.collection) : undefined;

  const allowedSortBy = ["created_at", "rating", "quality_score"] as const;
  type SortBy = (typeof allowedSortBy)[number];
  const sortByRaw = String(req.query.sortBy ?? "");
  const sortBy = (allowedSortBy as readonly string[]).includes(sortByRaw)
    ? (sortByRaw as SortBy)
    : undefined;

  const sortDir = req.query.sortDir === "asc" ? "asc" as const : req.query.sortDir === "desc" ? "desc" as const : undefined;

  try {
    const { entries } = searchEntries({ limit, offset, search, rating, minRating, collection, sortBy, sortDir });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="suno-history-${timestamp}.json"`);
    res.json({ exportedAt: new Date().toISOString(), count: entries.length, entries });
  } catch (err) {
    console.error("[history] export error:", err);
    res.status(500).json({ error: "Failed to export history" });
  }
});

/**
 * GET /api/collections
 * List all distinct collection names in use.
 * Response: { collections: string[] }
 */
router.get("/collections", (_req, res) => {
  try {
    const collections = listCollections();
    res.json({ collections });
  } catch (err) {
    console.error("[history] collections error:", err);
    res.status(500).json({ error: "Failed to load collections" });
  }
});

/**
 * POST /api/history
 * Save a new history entry.
 * Body: { id, createdAt, youtubeUrl, songTitle?, artist?, thumbnail?, template, rating?, qualityScore?, usedOptions?, collection? }
 */
router.post("/history", (req, res) => {
  const body = req.body as Partial<HistoryEntry>;
  if (!body.id || !body.youtubeUrl || !body.template) {
    res.status(400).json({ error: "Missing required fields: id, youtubeUrl, template" });
    return;
  }
  try {
    saveEntry({
      id: String(body.id),
      createdAt: typeof body.createdAt === "number" ? body.createdAt : Date.now(),
      youtubeUrl: String(body.youtubeUrl),
      songTitle: body.songTitle,
      artist: body.artist,
      thumbnail: body.thumbnail,
      template: body.template,
      rating: body.rating ?? null,
      qualityScore: body.qualityScore ?? null,
      usedOptions: body.usedOptions,
      collection: body.collection,
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("[history] save error:", err);
    res.status(500).json({ error: "Failed to save history entry" });
  }
});

/**
 * PATCH /api/history/:id/rating
 * Update the rating for a history entry.
 * Body: { rating: number | null }
 */
router.patch("/history/:id/rating", (req, res) => {
  const { id } = req.params;
  const { rating } = req.body as { rating?: number | null };
  if (rating !== null && rating !== undefined && (typeof rating !== "number" || rating < 1 || rating > 5)) {
    res.status(400).json({ error: "rating must be 1–5 or null" });
    return;
  }
  try {
    updateRating(id, rating ?? null);
    res.json({ ok: true });
  } catch (err) {
    console.error("[history] rating error:", err);
    res.status(500).json({ error: "Failed to update rating" });
  }
});

/**
 * PATCH /api/history/:id/collection
 * Set or clear the collection for a history entry.
 * Body: { collection: string | null }
 */
router.patch("/history/:id/collection", (req, res) => {
  const { id } = req.params;
  const { collection } = req.body as { collection?: string | null };
  if (collection !== null && collection !== undefined && typeof collection !== "string") {
    res.status(400).json({ error: "collection must be a string or null" });
    return;
  }
  try {
    updateCollection(id, collection ?? null);
    res.json({ ok: true });
  } catch (err) {
    console.error("[history] collection error:", err);
    res.status(500).json({ error: "Failed to update collection" });
  }
});

/**
 * DELETE /api/history/bulk
 * Delete multiple history entries by ID.
 * Body: { ids: string[] }
 * Response: { deleted: number }
 */
router.delete("/history/bulk", (req, res) => {
  const { ids } = req.body as { ids?: unknown };
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "ids must be a non-empty array of strings" });
    return;
  }
  if (ids.length > 200) {
    res.status(400).json({ error: "Cannot delete more than 200 entries at once" });
    return;
  }
  if (!ids.every((id) => typeof id === "string")) {
    res.status(400).json({ error: "All ids must be strings" });
    return;
  }
  try {
    let deleted = 0;
    for (const id of ids as string[]) {
      deleteEntry(id);
      deleted++;
    }
    res.json({ deleted });
  } catch (err) {
    console.error("[history] bulk delete error:", err);
    res.status(500).json({ error: "Failed to bulk delete entries" });
  }
});

/**
 * DELETE /api/history/:id
 * Delete a single history entry.
 */
router.delete("/history/:id", (req, res) => {
  try {
    deleteEntry(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[history] delete error:", err);
    res.status(500).json({ error: "Failed to delete entry" });
  }
});

/**
 * DELETE /api/history
 * Clear all history entries.
 */
router.delete("/history", (_req, res) => {
  try {
    clearHistory();
    res.json({ ok: true });
  } catch (err) {
    console.error("[history] clear error:", err);
    res.status(500).json({ error: "Failed to clear history" });
  }
});

/**
 * POST /api/share
 * Store a template and return a short hash that can be used to retrieve it.
 * Body: { youtubeUrl?: string, template: object }
 * Response: { hash: string, url: string }
 */
router.post("/share", (req, res) => {
  const { youtubeUrl, template } = req.body as { youtubeUrl?: string; template?: unknown };
  if (!template || typeof template !== "object") {
    res.status(400).json({ error: "Missing required field: template" });
    return;
  }
  try {
    const hash = saveShareLink(youtubeUrl ?? null, template);
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    res.json({ hash, url: `${baseUrl}/#share=${hash}` });
  } catch (err) {
    console.error("[share] save error:", err);
    res.status(500).json({ error: "Failed to create share link" });
  }
});

/**
 * GET /api/share/:hash
 * Retrieve a shared template by its short hash.
 * Response: { youtubeUrl: string | null, template: object }
 */
router.get("/share/:hash", (req, res) => {
  const { hash } = req.params;
  if (!/^[0-9a-f]{8}$/.test(hash)) {
    res.status(400).json({ error: "Invalid share hash" });
    return;
  }
  try {
    const result = getShareLink(hash);
    if (!result) {
      res.status(404).json({ error: "Share link not found or expired" });
      return;
    }
    res.json(result);
  } catch (err) {
    console.error("[share] get error:", err);
    res.status(500).json({ error: "Failed to retrieve share link" });
  }
});

export default router;
