import { spawn } from "child_process";
import path from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import log from "./logger.js";

// import.meta.url is undefined in esbuild CJS bundles (production build).
// Fall back to a path relative to CWD which is the repo root on the Pi.
const REPO_ROOT = (() => {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  } catch {
    return process.cwd();
  }
})();

const SCRIPT = path.resolve(REPO_ROOT, "artifacts/api-server/src/analyze_audio.py");
const VENV_PYTHON = path.resolve(REPO_ROOT, "artifacts/api-server/.venv-audio/bin/python3");
const MODEL_PATH = path.resolve(REPO_ROOT, "data/models/yamnet.tflite");
const CLASS_MAP_PATH = path.resolve(REPO_ROOT, "data/models/yamnet_class_map.csv");

const ANALYSIS_TIMEOUT_MS = 45_000;

export interface DominantChord {
  chord: string;
  weight: number;
}

export interface DetectedInstrument {
  name: string;
  confidence: number;
}

export interface DspAnalysisResult {
  bpm: number;
  key: string;
  keyConfidence: number;
  /** Recurring harmonic centers by time-share — not a bar-by-bar transcription. */
  dominantChords: DominantChord[];
  instruments: DetectedInstrument[];
  durationSeconds: number;
}

interface RawResult {
  success: boolean;
  bpm: number | null;
  key: string | null;
  keyConfidence: number | null;
  dominantChords: DominantChord[];
  instruments: DetectedInstrument[];
  durationSeconds: number | null;
  error: string | null;
}

let availabilityChecked = false;
let isAvailable = false;

/** Checked once at startup and logged — see startupCheck.ts. */
export function checkDspAnalysisAvailable(): boolean {
  if (!availabilityChecked) {
    isAvailable = existsSync(VENV_PYTHON) && existsSync(SCRIPT) && existsSync(MODEL_PATH) && existsSync(CLASS_MAP_PATH);
    availabilityChecked = true;
  }
  return isAvailable;
}

/**
 * Runs real DSP analysis (tempo, key, dominant chords, instrument tags) on a
 * downloaded audio sample via a Python subprocess (librosa + YAMNet in an
 * isolated venv — see requirements-audio.txt). Best-effort: returns null on
 * any failure (missing venv/model, ffmpeg decode failure, timeout) rather
 * than throwing. Takes ~10-15s for a full-length song.
 */
export async function analyzeAudioDsp(audioFilePath: string): Promise<DspAnalysisResult | null> {
  if (!checkDspAnalysisAvailable()) return null;

  return new Promise((resolve) => {
    const py = spawn(VENV_PYTHON, [SCRIPT], { timeout: ANALYSIS_TIMEOUT_MS });

    let stdout = "";
    let stderr = "";

    py.stdout.on("data", (chunk) => (stdout += chunk));
    py.stderr.on("data", (chunk) => (stderr += chunk));

    py.on("error", (err) => {
      log.warn(`[dspAnalysis] spawn error: ${err.message} — skipping`);
      resolve(null);
    });

    py.on("close", (code) => {
      if (code !== 0) {
        log.warn(`[dspAnalysis] exit ${code}: ${stderr.trim().slice(0, 300)}`);
        resolve(null);
        return;
      }
      try {
        const raw = JSON.parse(stdout) as RawResult;
        if (!raw.success || raw.bpm == null || raw.key == null) {
          log.warn(`[dspAnalysis] analysis failed: ${raw.error ?? "unknown"}`);
          resolve(null);
          return;
        }
        resolve({
          bpm: raw.bpm,
          key: raw.key,
          keyConfidence: raw.keyConfidence ?? 0.5,
          dominantChords: raw.dominantChords,
          instruments: raw.instruments,
          durationSeconds: raw.durationSeconds ?? 0,
        });
      } catch {
        log.warn(`[dspAnalysis] JSON parse error: ${stdout.slice(0, 200)}`);
        resolve(null);
      }
    });

    py.stdin.write(JSON.stringify({ audioPath: audioFilePath, modelPath: MODEL_PATH, classMapPath: CLASS_MAP_PATH }));
    py.stdin.end();
  });
}
