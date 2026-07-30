import { execFile } from "child_process";
import { promisify } from "util";
import { readdir, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import log from "./logger.js";

const execFileAsync = promisify(execFile);
const DOWNLOAD_TIMEOUT_MS = 25000;
// fpcalc's default fingerprint window is 120s — a low-bitrate audio-only stream comfortably
// fits that in a few MB, so this cap (yt-dlp's --max-filesize) is a safety net, not a real
// constraint in practice.
const MAX_FILESIZE = "8M";

/**
 * Downloads a short audio-only sample of a YouTube video to a temp file for fingerprinting, via
 * the yt-dlp binary (must be on PATH — @distube/ytdl-core cannot extract playable stream URLs
 * against YouTube's current player and is only used elsewhere for metadata lookups).
 * Best-effort: returns null on any failure (network, missing binary, timeout, etc.) rather than
 * throwing — this must never block the main generation pipeline. Callers must delete the
 * returned path with cleanupAudioSample() when done.
 */
export async function downloadAudioSample(url: string): Promise<string | null> {
  const stem = `ttmpl-audio-${randomUUID()}`;
  const tempPath = join(tmpdir(), `${stem}.%(ext)s`);

  try {
    await execFileAsync(
      "yt-dlp",
      [
        "-f",
        "worstaudio/worst",
        "--no-playlist",
        "--no-warnings",
        "--max-filesize",
        MAX_FILESIZE,
        "-o",
        tempPath,
        url,
      ],
      { timeout: DOWNLOAD_TIMEOUT_MS },
    );
  } catch (err) {
    log.warn("[audioDownload] yt-dlp failed", (err as Error).message?.slice(0, 200));
    return null;
  }

  // yt-dlp substitutes %(ext)s with the actual container extension (m4a, webm, ...); find it.
  const files = await readdir(tmpdir());
  const match = files.find((f) => f.startsWith(stem));
  return match ? join(tmpdir(), match) : null;
}

export async function cleanupAudioSample(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // already gone or never created — fine
  }
}
