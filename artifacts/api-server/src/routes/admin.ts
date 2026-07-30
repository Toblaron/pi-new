import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { createReadStream } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { timingSafeEqual } from "crypto";
import { cacheStats, db } from "../lib/cache.js";
import { getUsageStats } from "../lib/costTracker.js";
import log from "../lib/logger.js";

let resolvedFilename: string;
try {
  resolvedFilename = fileURLToPath(import.meta.url);
} catch {
  // @ts-ignore
  resolvedFilename = typeof __filename !== "undefined" ? __filename : "";
}
const resolvedDirname = dirname(resolvedFilename);

// Load tag dictionary at startup (fail fast if missing)
const tagDictionaryPath = join(resolvedDirname, "../data/sunoTagDictionary.json");
const tagDictionary = JSON.parse(readFileSync(tagDictionaryPath, "utf-8")) as {
  version: string;
  tags: Array<{ tag: string; grade: string; category: string; notes?: string }>;
};

const router: IRouter = Router();

// Auth middleware — only applied if ADMIN_KEY is set. If unset, /admin/* (including
// /admin/backup, a full raw DB download) is completely open — see the startup warning below.
if (!process.env.ADMIN_KEY) {
  log.warn("ADMIN_KEY is not set — /api/admin/* is unauthenticated, including /admin/backup (full database download). Set ADMIN_KEY if this server is reachable beyond a trusted LAN.");
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Length must match for timingSafeEqual — comparing lengths first is a negligible,
  // widely-accepted leak (it doesn't reveal any byte of the actual secret).
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    next();
    return;
  }
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const token = authHeader.slice(7);
  if (!tokensMatch(token, adminKey)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

function getPendingRunningCounts(): { pending: number; running: number } {
  const pendingRow = db.prepare("SELECT COUNT(*) as cnt FROM job_queue WHERE status = 'pending'")
    .get() as { cnt: number };
  const runningRow = db.prepare("SELECT COUNT(*) as cnt FROM job_queue WHERE status = 'running'")
    .get() as { cnt: number };
  return { pending: pendingRow.cnt, running: runningRow.cnt };
}

// GET /admin/health
router.get("/admin/health", adminAuth, (_req: Request, res: Response) => {
  const queueCounts = getPendingRunningCounts();
  res.json({
    status: "ok",
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cache: cacheStats(),
    queue: queueCounts,
    usage: getUsageStats(7),
    timestamp: Date.now(),
  });
});

// GET /admin/usage?days=7
router.get("/admin/usage", adminAuth, (req: Request, res: Response) => {
  const days = parseInt((req.query["days"] as string) ?? "7", 10);
  const safeDays = isNaN(days) || days < 1 ? 7 : Math.min(days, 365);
  res.json(getUsageStats(safeDays));
});

// GET /admin/backup — stream DB file as download
router.get("/admin/backup", adminAuth, (_req: Request, res: Response) => {
  const dbPath = (db as unknown as { name: string }).name;
  const timestamp = Date.now();
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="suno-backup-${timestamp}.db"`);
  const stream = createReadStream(dbPath);
  stream.on("error", (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to stream database", detail: err.message });
    }
  });
  stream.pipe(res);
});

// GET /admin/tags — return full tag dictionary
router.get("/admin/tags", adminAuth, (_req: Request, res: Response) => {
  res.json(tagDictionary);
});

// GET /admin/tags/:category — return tags filtered by category
router.get("/admin/tags/:category", adminAuth, (req: Request, res: Response) => {
  const { category } = req.params;
  const filtered = tagDictionary.tags.filter((t) => t.category === category);
  if (filtered.length === 0) {
    res.status(404).json({ error: `No tags found for category: ${category}` });
    return;
  }
  res.json({ version: tagDictionary.version, category, tags: filtered });
});

export default router;
