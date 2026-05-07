/**
 * Server-side template history store.
 * Reuses the single shared SQLite connection from cache.ts.
 * Each entry stores a full generated template + the source YouTube URL + optional rating.
 */
import { createHash } from "crypto";
import { db } from "./cache.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS template_history (
    id          TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL,
    youtube_url TEXT NOT NULL,
    song_title  TEXT,
    artist      TEXT,
    thumbnail   TEXT,
    template    TEXT NOT NULL,
    rating      INTEGER,
    quality_score REAL,
    used_options TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_history_created ON template_history (created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_history_artist ON template_history (artist);
  CREATE INDEX IF NOT EXISTS idx_history_rating ON template_history (rating);

  CREATE TABLE IF NOT EXISTS shared_templates (
    hash        TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL,
    youtube_url TEXT,
    template    TEXT NOT NULL
  );
`);

// Safely add collection column — no-op if it already exists
try {
  db.exec(`ALTER TABLE template_history ADD COLUMN collection TEXT`);
} catch { /* column already exists */ }

export interface HistoryEntry {
  id: string;
  createdAt: number;
  youtubeUrl: string;
  songTitle?: string;
  artist?: string;
  thumbnail?: string;
  template: unknown;
  rating?: number | null;
  qualityScore?: number | null;
  usedOptions?: unknown;
  collection?: string;
}

const insertStmt = db.prepare<[string, number, string, string | null, string | null, string | null, string, number | null, number | null, string | null, string | null]>(`
  INSERT OR REPLACE INTO template_history
    (id, created_at, youtube_url, song_title, artist, thumbnail, template, rating, quality_score, used_options, collection)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const listStmt = db.prepare<[number]>(`
  SELECT * FROM template_history ORDER BY created_at DESC LIMIT ?
`);

const updateRatingStmt = db.prepare<[number | null, string]>(`
  UPDATE template_history SET rating = ? WHERE id = ?
`);

const deleteStmt = db.prepare<[string]>(`DELETE FROM template_history WHERE id = ?`);
const clearStmt = db.prepare<[]>(`DELETE FROM template_history`);

const insertShareStmt = db.prepare<[string, number, string | null, string]>(`
  INSERT OR REPLACE INTO shared_templates (hash, created_at, youtube_url, template)
  VALUES (?, ?, ?, ?)
`);

const getShareStmt = db.prepare<[string]>(`SELECT * FROM shared_templates WHERE hash = ?`);

export function saveEntry(entry: HistoryEntry): void {
  insertStmt.run(
    entry.id,
    entry.createdAt,
    entry.youtubeUrl,
    entry.songTitle ?? null,
    entry.artist ?? null,
    entry.thumbnail ?? null,
    JSON.stringify(entry.template),
    entry.rating ?? null,
    entry.qualityScore ?? null,
    entry.usedOptions ? JSON.stringify(entry.usedOptions) : null,
    entry.collection ?? null,
  );
}

interface RawRow {
  id: string;
  created_at: number;
  youtube_url: string;
  song_title: string | null;
  artist: string | null;
  thumbnail: string | null;
  template: string;
  rating: number | null;
  quality_score: number | null;
  used_options: string | null;
  collection: string | null;
}

function rowToEntry(row: RawRow): HistoryEntry {
  return {
    id: row.id,
    createdAt: row.created_at,
    youtubeUrl: row.youtube_url,
    songTitle: row.song_title ?? undefined,
    artist: row.artist ?? undefined,
    thumbnail: row.thumbnail ?? undefined,
    template: JSON.parse(row.template) as unknown,
    rating: row.rating ?? null,
    qualityScore: row.quality_score ?? null,
    usedOptions: row.used_options ? JSON.parse(row.used_options) as unknown : undefined,
    collection: row.collection ?? undefined,
  };
}

export function listEntries(limit = 50): HistoryEntry[] {
  const rows = listStmt.all(limit) as RawRow[];
  return rows.map(rowToEntry);
}

// ── Search / filter ───────────────────────────────────────────────────────────

export interface HistorySearchOptions {
  limit?: number;
  offset?: number;
  search?: string;       // LIKE match on song_title OR artist
  rating?: number;       // exact rating match
  minRating?: number;
  collection?: string;
  sortBy?: "created_at" | "rating" | "quality_score";
  sortDir?: "asc" | "desc";
}

export function searchEntries(opts: HistorySearchOptions = {}): { entries: HistoryEntry[]; total: number } {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  // Allowed column names — never interpolate user-supplied values directly
  const allowedSortBy: Record<string, string> = {
    created_at: "created_at",
    rating: "rating",
    quality_score: "quality_score",
  };
  const sortCol = allowedSortBy[opts.sortBy ?? "created_at"] ?? "created_at";
  const sortDir = opts.sortDir === "asc" ? "ASC" : "DESC";

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.search) {
    conditions.push("(song_title LIKE ? OR artist LIKE ?)");
    const pattern = `%${opts.search}%`;
    params.push(pattern, pattern);
  }

  if (opts.rating !== undefined) {
    conditions.push("rating = ?");
    params.push(opts.rating);
  }

  if (opts.minRating !== undefined) {
    conditions.push("rating >= ?");
    params.push(opts.minRating);
  }

  if (opts.collection !== undefined) {
    conditions.push("collection = ?");
    params.push(opts.collection);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRow = db.prepare<(string | number)[]>(
    `SELECT COUNT(*) AS cnt FROM template_history ${where}`
  ).get(...params) as { cnt: number };

  const rows = db.prepare<(string | number)[]>(
    `SELECT * FROM template_history ${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as RawRow[];

  return {
    entries: rows.map(rowToEntry),
    total: countRow.cnt,
  };
}

// ── Collections ───────────────────────────────────────────────────────────────

export function listCollections(): string[] {
  const rows = db.prepare(
    `SELECT DISTINCT collection FROM template_history WHERE collection IS NOT NULL ORDER BY collection`
  ).all() as { collection: string }[];
  return rows.map((r) => r.collection);
}

export function updateCollection(id: string, collection: string | null): void {
  db.prepare<[string | null, string]>(
    `UPDATE template_history SET collection = ? WHERE id = ?`
  ).run(collection, id);
}

// ── Rating ────────────────────────────────────────────────────────────────────

export function updateRating(id: string, rating: number | null): void {
  updateRatingStmt.run(rating, id);
}

export function deleteEntry(id: string): void {
  deleteStmt.run(id);
}

export function clearHistory(): void {
  clearStmt.run();
}

// ── Short links ──────────────────────────────────────────────────────────────

export function saveShareLink(youtubeUrl: string | null, template: unknown): string {
  const payload = JSON.stringify({ youtubeUrl, template });
  const hash = createHash("sha1").update(payload).digest("hex").slice(0, 8);
  insertShareStmt.run(hash, Date.now(), youtubeUrl, payload);
  return hash;
}

interface ShareRow {
  hash: string;
  created_at: number;
  youtube_url: string | null;
  template: string;
}

export function getShareLink(hash: string): { youtubeUrl: string | null; template: unknown } | null {
  const row = getShareStmt.get(hash) as ShareRow | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.template) as { youtubeUrl?: string; template?: unknown };
    return { youtubeUrl: parsed.youtubeUrl ?? null, template: parsed.template };
  } catch {
    return null;
  }
}
