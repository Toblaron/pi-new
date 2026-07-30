import ytdl from "@distube/ytdl-core";
import { createWriteStream } from "fs";
import { unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import log from "./logger.js";

const DOWNLOAD_TIMEOUT_MS = 25000;
// fpcalc's default fingerprint window is 120s — a low-bitrate audio-only stream comfortably
// fits that in a few MB, so this cap is a safety net, not a real constraint in practice.
const MAX_BYTES = 6 * 1024 * 1024;

/**
 * Downloads a short audio-only sample of a YouTube video to a temp file for fingerprinting.
 * Best-effort: returns null on any failure (network, no audio-only format, timeout, etc.) rather
 * than throwing — this must never block the main generation pipeline. Callers must delete the
 * returned path with cleanupAudioSample() when done.
 */
export async function downloadAudioSample(url: string): Promise<string | null> {
  const tempPath = join(tmpdir(), `ttmpl-audio-${randomUUID()}.tmp`);

  return new Promise((resolve) => {
    let settled = false;
    let bytesWritten = 0;

    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      stream.destroy();
      finish(null);
    }, DOWNLOAD_TIMEOUT_MS);

    let stream: ReturnType<typeof ytdl>;
    try {
      stream = ytdl(url, { filter: "audioonly", quality: "lowestaudio" });
    } catch (err) {
      clearTimeout(timer);
      log.warn("[audioDownload] failed to start stream", err);
      finish(null);
      return;
    }

    const writeStream = createWriteStream(tempPath);

    stream.on("data", (chunk: Buffer) => {
      bytesWritten += chunk.length;
      if (bytesWritten >= MAX_BYTES) {
        stream.unpipe(writeStream);
        stream.destroy();
        writeStream.end();
      }
    });

    stream.on("error", (err) => {
      log.warn("[audioDownload] stream error", (err as Error).message?.slice(0, 120));
      writeStream.end();
      finish(null);
    });

    writeStream.on("finish", () => finish(tempPath));
    writeStream.on("error", (err) => {
      log.warn("[audioDownload] write error", err);
      finish(null);
    });

    stream.pipe(writeStream);
  });
}

export async function cleanupAudioSample(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // already gone or never created — fine
  }
}
