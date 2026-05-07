import { db } from "./cache.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS job_queue (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    result TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON job_queue (status, created_at);
`);

export interface JobRecord {
  id: string;
  type: string;
  payload: unknown;
  status: "pending" | "running" | "done" | "failed";
  created_at: number;
  started_at?: number;
  completed_at?: number;
  result?: unknown;
  error?: string;
}

interface JobRow {
  id: string;
  type: string;
  payload: string;
  status: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  result: string | null;
  error: string | null;
}

function rowToRecord(row: JobRow): JobRecord {
  const record: JobRecord = {
    id: row.id,
    type: row.type,
    payload: JSON.parse(row.payload),
    status: row.status as JobRecord["status"],
    created_at: row.created_at,
  };
  if (row.started_at != null) record.started_at = row.started_at;
  if (row.completed_at != null) record.completed_at = row.completed_at;
  if (row.result != null) record.result = JSON.parse(row.result);
  if (row.error != null) record.error = row.error;
  return record;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const insertJob = db.prepare<[string, string, string, number]>(
  `INSERT INTO job_queue (id, type, payload, created_at) VALUES (?, ?, ?, ?)`,
);

const getJobStmt = db.prepare<[string]>(
  `SELECT * FROM job_queue WHERE id = ?`,
);

export function enqueueJob(type: string, payload: unknown): string {
  const id = generateId();
  insertJob.run(id, type, JSON.stringify(payload), Date.now());
  return id;
}

export function getJob(id: string): JobRecord | null {
  const row = getJobStmt.get(id) as JobRow | undefined;
  if (!row) return null;
  return rowToRecord(row);
}

export function updateJob(
  id: string,
  updates: Partial<Pick<JobRecord, "status" | "result" | "error" | "started_at" | "completed_at">>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
  if (updates.result !== undefined) { fields.push("result = ?"); values.push(JSON.stringify(updates.result)); }
  if (updates.error !== undefined) { fields.push("error = ?"); values.push(updates.error); }
  if (updates.started_at !== undefined) { fields.push("started_at = ?"); values.push(updates.started_at); }
  if (updates.completed_at !== undefined) { fields.push("completed_at = ?"); values.push(updates.completed_at); }

  if (fields.length === 0) return;

  values.push(id);
  const stmt = db.prepare(`UPDATE job_queue SET ${fields.join(", ")} WHERE id = ?`);
  stmt.run(...values);
}

// Atomically claim the oldest pending job of a given type
const claimNextJobTx = db.transaction((type: string): JobRecord | null => {
  const row = db.prepare<[string]>(
    `SELECT * FROM job_queue WHERE type = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1`,
  ).get(type) as JobRow | undefined;

  if (!row) return null;

  db.prepare<[number, string]>(
    `UPDATE job_queue SET status = 'running', started_at = ? WHERE id = ?`,
  ).run(Date.now(), row.id);

  row.status = "running";
  return rowToRecord(row);
});

export function claimNextJob(type: string): JobRecord | null {
  return claimNextJobTx(type);
}

export function cleanOldJobs(olderThanMs: number = 24 * 60 * 60 * 1000): void {
  const cutoff = Date.now() - olderThanMs;
  db.prepare<[number]>(
    `DELETE FROM job_queue WHERE status IN ('done', 'failed') AND completed_at IS NOT NULL AND completed_at < ?`,
  ).run(cutoff);
}
