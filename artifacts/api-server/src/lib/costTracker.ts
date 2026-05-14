import { db } from "./cache.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    endpoint TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log (ts DESC);
`);

const insertUsage = db.prepare<[number, string, number, number, number, string | null]>(
  `INSERT INTO usage_log (ts, model, prompt_tokens, completion_tokens, total_tokens, endpoint)
   VALUES (?, ?, ?, ?, ?, ?)`,
);

interface UsageRow {
  model: string;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

const queryStats = db.prepare<[number]>(`
  SELECT
    model,
    COUNT(*) as calls,
    SUM(prompt_tokens) as prompt_tokens,
    SUM(completion_tokens) as completion_tokens,
    SUM(total_tokens) as total_tokens
  FROM usage_log
  WHERE ts >= ?
  GROUP BY model
`);

/** Pricing per 1k tokens: [inputPer1k, outputPer1k] */
const MODEL_PRICING: Record<string, [number, number]> = {
  "gpt-5.2":       [0.015,  0.060],
  "gpt-4o":        [0.0025, 0.010],
  "gpt-4o-mini":   [0.00015, 0.0006],
  "gpt-4.1":       [0.002,  0.008],
  "gpt-4.1-mini":  [0.0004, 0.0016],
  "gpt-4.1-nano":  [0.0001, 0.0004],
};

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (pricing) {
    const [inputRate, outputRate] = pricing;
    return (promptTokens / 1000) * inputRate + (completionTokens / 1000) * outputRate;
  }
  // Unknown model — flat $0.01/1k total tokens
  return ((promptTokens + completionTokens) / 1000) * 0.01;
}

export function trackUsage(
  model: string,
  promptTokens: number,
  completionTokens: number,
  endpoint?: string,
): void {
  const totalTokens = promptTokens + completionTokens;
  insertUsage.run(Date.now(), model, promptTokens, completionTokens, totalTokens, endpoint ?? null);
}

export interface UsageStats {
  totalCalls: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  byModel: Record<string, { calls: number; tokens: number }>;
  estimatedUsdCost: number;
}

export function getUsageStats(periodDays: number = 7): UsageStats {
  const since = Date.now() - periodDays * 24 * 60 * 60 * 1000;
  const rows = queryStats.all(since) as UsageRow[];

  let totalCalls = 0;
  let totalTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let estimatedUsdCost = 0;
  const byModel: Record<string, { calls: number; tokens: number }> = {};

  for (const row of rows) {
    totalCalls += row.calls;
    totalTokens += row.total_tokens;
    promptTokens += row.prompt_tokens;
    completionTokens += row.completion_tokens;
    estimatedUsdCost += estimateCost(row.model, row.prompt_tokens, row.completion_tokens);
    byModel[row.model] = { calls: row.calls, tokens: row.total_tokens };
  }

  return { totalCalls, totalTokens, promptTokens, completionTokens, byModel, estimatedUsdCost };
}
