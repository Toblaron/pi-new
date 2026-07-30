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
    // A failed/timed-out/oversize-aborted download can still leave a partial file (or yt-dlp's
    // own <name>.part) behind on tmpfs — clean it up rather than leaking it until reboot.
    await cleanupByStem(stem);
    return null;
  }

  // yt-dlp substitutes %(ext)s with the actual container extension (m4a, webm, ...); find it.
  const match = await findByStem(stem);
  return match ? join(tmpdir(), match) : null;
}

async function findByStem(stem: string): Promise<string | undefined> {
  const files = await readdir(tmpdir());
  return files.find((f) => f.startsWith(stem));
}

async function cleanupByStem(stem: string): Promise<void> {
  try {
    const files = await readdir(tmpdir());
    await Promise.all(
      files.filter((f) => f.startsWith(stem)).map((f) => unlink(join(tmpdir(), f)).catch(() => undefined)),
    );
  } catch {
    // best-effort — tmpdir unreadable would be a bigger problem than a leaked file
  }
}

export async function cleanupAudioSample(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // already gone or never created — fine
  }
}
