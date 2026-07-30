import { execFile } from "child_process";
import { promisify } from "util";
import log from "./logger.js";
import { checkDspAnalysisAvailable } from "./dspAnalysis.js";

const execFileAsync = promisify(execFile);

async function binaryExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync(cmd, ["--version"], { timeout: 3000 });
    return true;
  } catch (err) {
    // ENOENT = not found; any other error (e.g. bad flag) still means the binary exists
    return !(err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT");
  }
}

// Cached after first check — a binary's presence doesn't change at runtime, and this is
// polled by /api/healthz, so it shouldn't spawn a process on every request.
let python3Cache: Promise<boolean> | null = null;
export function checkPython3Available(): Promise<boolean> {
  if (!python3Cache) python3Cache = binaryExists("python3");
  return python3Cache;
}

/**
 * Logs which optional integrations are actually configured at boot. Every source below fails
 * silently and falls back gracefully per-request when unconfigured — this makes "why are my
 * templates generic?" answerable from the startup log instead of guessed at.
 */
export async function logIntegrationStatus(): Promise<void> {
  const [python3, fpcalc] = await Promise.all([checkPython3Available(), binaryExists("fpcalc")]);

  const rows: Array<[string, boolean]> = [
    ["Genius (lyrics)", !!process.env.GENIUS_API_TOKEN],
    ["GetSongBPM (tempo/key)", !!process.env.GETSONGBPM_API_KEY],
    ["Last.fm (genre/mood tags)", !!process.env.LASTFM_API_KEY],
    ["Discogs (styles/year)", !!process.env.DISCOGS_TOKEN],
    ["AcoustID (audio fingerprint fallback)", !!process.env.ACOUSTID_API_KEY],
    ["python3 (field validator)", python3],
    ["fpcalc (audio fingerprinting)", fpcalc],
    ["DSP analysis (real tempo/key/chords/instruments)", checkDspAnalysisAvailable()],
  ];

  log.info("Integration status:");
  for (const [name, ok] of rows) {
    log.info(`  ${ok ? "✓" : "✗"} ${name}`);
  }
  if (!python3) {
    log.warn("python3 not found — field length validation/padding will be skipped for every generation.");
  }
  if (!checkDspAnalysisAvailable()) {
    log.warn("DSP analysis venv/model not found — audio features will stay estimate-only (description/GetSongBPM/AI-knowledge). See artifacts/api-server/requirements-audio.txt and data/models/.");
  }
}
