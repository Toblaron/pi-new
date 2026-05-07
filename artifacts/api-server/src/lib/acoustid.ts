import { execFile } from "child_process";
import { promisify } from "util";
import log from "./logger.js";

const execFileAsync = promisify(execFile);
const FPCALC_TIMEOUT_MS = 30000;
const ACOUSTID_TIMEOUT_MS = 10000;

export interface AcoustIDResult {
  title?: string;
  artist?: string;
  releaseYear?: string;
  mbid?: string;
  confidence: number;
}

interface FpcalcOutput {
  duration: number;
  fingerprint: string;
}

interface AcoustIDRecording {
  id?: string;
  title?: string;
  artists?: Array<{ id?: string; name?: string }>;
  releasegroups?: Array<{
    id?: string;
    title?: string;
    type?: string;
    "first-release-date"?: string;
    firstreleasedate?: string;
  }>;
}

interface AcoustIDResultItem {
  id: string;
  score: number;
  recordings?: AcoustIDRecording[];
}

interface AcoustIDResponse {
  status: string;
  results?: AcoustIDResultItem[];
  error?: { message?: string; code?: number };
}

export async function identifyByFingerprint(
  audioFilePath: string,
): Promise<AcoustIDResult | null> {
  const apiKey = process.env.ACOUSTID_API_KEY;
  if (!apiKey) return null;

  // Run fpcalc to get fingerprint
  let fpcalcOutput: FpcalcOutput;
  try {
    const { stdout } = await execFileAsync("fpcalc", ["-json", audioFilePath], {
      timeout: FPCALC_TIMEOUT_MS,
    });
    fpcalcOutput = JSON.parse(stdout) as FpcalcOutput;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      log.warn("fpcalc binary not found — AcoustID fingerprinting unavailable. Install fpcalc (apt install libchromaprint-tools on Debian/Pi).");
      return null;
    }
    log.warn("fpcalc execution failed", err);
    return null;
  }

  if (!fpcalcOutput.fingerprint || !fpcalcOutput.duration) return null;

  // Query AcoustID API
  try {
    const body = new URLSearchParams({
      client: apiKey,
      duration: Math.round(fpcalcOutput.duration).toString(),
      fingerprint: fpcalcOutput.fingerprint,
      meta: "recordings+releasegroups+compress",
    });

    const signal = AbortSignal.timeout(ACOUSTID_TIMEOUT_MS);
    const response = await fetch("https://api.acoustid.org/v2/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal,
    });

    if (!response.ok) return null;

    const data = await response.json() as AcoustIDResponse;

    if (data.status !== "ok" || !data.results || data.results.length === 0) return null;

    // Pick best result by score
    const best = data.results.reduce<AcoustIDResultItem | null>((top, r) => {
      if (!top || r.score > top.score) return r;
      return top;
    }, null);

    if (!best || !best.recordings || best.recordings.length === 0) {
      return { confidence: best?.score ?? 0 };
    }

    const recording = best.recordings[0];
    const result: AcoustIDResult = { confidence: best.score };

    if (recording.title) result.title = recording.title;
    if (recording.id) result.mbid = recording.id;

    if (recording.artists && recording.artists.length > 0) {
      result.artist = recording.artists[0].name;
    }

    const releaseGroups = recording.releasegroups;
    if (releaseGroups && releaseGroups.length > 0) {
      const rg = releaseGroups[0];
      const dateStr = rg["first-release-date"] ?? rg.firstreleasedate;
      if (dateStr) {
        result.releaseYear = dateStr.slice(0, 4);
      }
    }

    return result;
  } catch (err) {
    log.warn("AcoustID lookup failed", err);
    return null;
  }
}
