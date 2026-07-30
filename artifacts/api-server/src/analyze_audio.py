#!/usr/bin/env python3
"""
Real DSP audio analysis: tempo, key, chord progression, and instrument tags,
measured from an actual downloaded audio sample (not estimated from text).

Reads JSON from stdin:
  { "audioPath": "...", "modelPath": "...", "classMapPath": "..." }

Writes JSON to stdout:
  {
    "success": bool,
    "bpm": float | null,
    "key": str | null,             # e.g. "F# minor"
    "keyConfidence": float | null, # 0-1, strength of the profile correlation
    "dominantChords": [{"chord": str, "weight": float}],  # recurring harmonic
                                    # centers by time-share, NOT a bar-by-bar
                                    # transcription — see _detect_dominant_chords
    "instruments": [{"name": str, "confidence": float}],
    "durationSeconds": float | null,
    "error": str | null
  }

Tempo: librosa onset-strength + beat tracking (standard, well-validated approach).
Key: Krumhansl-Schmuckler key-profile correlation against beat-averaged chroma —
  a classical, well-documented technique (~24 candidate keys, no ML model needed).
Chords: beat-synchronized chroma correlated against 24 major/minor triad templates,
  median-smoothed, then summarized as the most time-heavy chords. Raw per-beat
  template matching flickers almost every beat on real tracks (verified
  empirically) — not accurate enough to present as a real chord progression, so
  this reports recurring harmonic centers instead of a bar-by-bar transcription.
Instruments: YAMNet (Google's pretrained AudioSet classifier, TFLite), filtered to a
  curated subset of its 521 classes that are actual instruments (not genre/mood/scene
  labels, which dominate raw YAMNet output for music). Peak (not mean) score is used
  per class so a brief instrumental passage still registers.
"""

import sys
import json
import subprocess
import tempfile
import os

import numpy as np

# ── Key detection: Krumhansl-Kessler key profiles ────────────────────────────
_MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
_PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# ── Chord templates: simple major/minor triads (root, third, fifth) ──────────
_CHORD_LABELS = []
_CHORD_TEMPLATES = []
for i, root in enumerate(_PITCH_CLASSES):
    major = np.zeros(12)
    major[[i, (i + 4) % 12, (i + 7) % 12]] = 1
    _CHORD_LABELS.append(f"{root}maj")
    _CHORD_TEMPLATES.append(major)

    minor = np.zeros(12)
    minor[[i, (i + 3) % 12, (i + 7) % 12]] = 1
    _CHORD_LABELS.append(f"{root}min")
    _CHORD_TEMPLATES.append(minor)
_CHORD_TEMPLATES = np.array(_CHORD_TEMPLATES)

# ── Curated instrument subset of YAMNet's 521 AudioSet classes ───────────────
# Raw YAMNet output for music is dominated by genre/mood/scene labels ("Music",
# "Pop music", "Exciting music"); this list restricts output to classes that
# actually name a physical or synthesized instrument.
_INSTRUMENT_CLASSES = {
    "Guitar", "Electric guitar", "Bass guitar", "Acoustic guitar",
    "Steel guitar, slide guitar", "Tapping (guitar technique)", "Ukulele", "Banjo", "Mandolin",
    "Piano", "Electric piano", "Organ", "Electronic organ", "Hammond organ",
    "Synthesizer", "Sampler", "Drum machine",
    "Percussion", "Drum kit", "Drum", "Snare drum", "Bass drum", "Hi-hat", "Cymbal",
    "Tabla", "Cowbell", "Drum and bass",
    "Violin, fiddle", "Cello", "Double bass", "String section",
    "Trumpet", "Trombone", "Brass instrument", "French horn",
  "Saxophone", "Clarinet", "Flute", "Bagpipes", "Harmonica", "Accordion",
    "Harp", "Choir", "Bell", "Church bell", "Chime",
    "Vibraphone", "Marimba, xylophone", "Glockenspiel",
    "Scratching (performance technique)", "Beatboxing",
}


def _run(cmd: list[str], timeout: int) -> None:
    subprocess.run(cmd, check=True, timeout=timeout, capture_output=True)


def _detect_key(chroma_mean: np.ndarray) -> tuple[str, float]:
    scores = []
    for shift in range(12):
        maj = np.roll(_MAJOR_PROFILE, shift)
        minr = np.roll(_MINOR_PROFILE, shift)
        scores.append((np.corrcoef(chroma_mean, maj)[0, 1], f"{_PITCH_CLASSES[shift]} major"))
        scores.append((np.corrcoef(chroma_mean, minr)[0, 1], f"{_PITCH_CLASSES[shift]} minor"))
    scores.sort(key=lambda x: -x[0])
    best_score, best_key = scores[0]
    second_score = scores[1][0]
    # Confidence reflects how decisively the winner beat the runner-up, not the
    # raw correlation (which is often ~0.6-0.8 even for a clear match).
    confidence = float(np.clip(0.5 + (best_score - second_score), 0.4, 0.97))
    return best_key, confidence


def _detect_dominant_chords(chroma: np.ndarray, beat_frames: np.ndarray) -> list[dict]:
    """
    Per-beat triad template matching is too noisy to present as a reliable
    bar-by-bar progression (raw per-beat labels flicker almost every beat on
    real tracks — verified empirically, not a plausible chord-change rate for
    any real song). Instead: median-smooth the per-beat chord estimate, then
    report the chords that occupy the most total time as the track's
    recurring harmonic centers. Honest about being a summary, not a
    transcription — no 7ths/extensions/inversions, just closest major/minor
    triad per beat.
    """
    if len(beat_frames) < 4:
        return []
    import librosa
    from scipy.ndimage import median_filter
    from collections import Counter

    beat_chroma = librosa.util.sync(chroma, beat_frames, aggregate=np.median)
    norm_chroma = beat_chroma / (np.linalg.norm(beat_chroma, axis=0, keepdims=True) + 1e-9)
    norm_templates = _CHORD_TEMPLATES / np.linalg.norm(_CHORD_TEMPLATES, axis=1, keepdims=True)
    sims = norm_templates @ norm_chroma
    best_idx = np.argmax(sims, axis=0)
    smoothed_idx = median_filter(best_idx, size=9, mode="nearest")

    counts = Counter(_CHORD_LABELS[i] for i in smoothed_idx)
    total = sum(counts.values())
    return [
        {"chord": chord, "weight": round(count / total, 3)}
        for chord, count in counts.most_common(6)
        if count / total >= 0.03
    ]


def _detect_instruments(wav16k_path: str, model_path: str, class_map_path: str) -> list[dict]:
    from ai_edge_litert.interpreter import Interpreter
    import soundfile as sf
    import csv

    interpreter = Interpreter(model_path=model_path)
    input_details = interpreter.get_input_details()
    output_details = interpreter.get_output_details()

    waveform, _sr = sf.read(wav16k_path, dtype="float32")
    interpreter.resize_tensor_input(input_details[0]["index"], [len(waveform)])
    interpreter.allocate_tensors()
    interpreter.set_tensor(input_details[0]["index"], waveform)
    interpreter.invoke()
    scores = interpreter.get_tensor(output_details[0]["index"])  # (frames, 521)
    peak_scores = scores.max(axis=0)

    classes = {}
    with open(class_map_path) as f:
        for row in csv.DictReader(f):
            classes[int(row["index"])] = row["display_name"]

    results = []
    for idx, name in classes.items():
        if name in _INSTRUMENT_CLASSES and peak_scores[idx] > 0.15:
            results.append({"name": name, "confidence": round(float(peak_scores[idx]), 3)})

    results.sort(key=lambda r: -r["confidence"])
    return results[:10]


def analyze(audio_path: str, model_path: str, class_map_path: str) -> dict:
    import librosa

    with tempfile.TemporaryDirectory() as tmp:
        wav22k = os.path.join(tmp, "audio22k.wav")
        wav16k = os.path.join(tmp, "audio16k.wav")

        # Pre-converting via ffmpeg first is ~8x faster than letting librosa's
        # audioread fallback decode compressed formats (m4a/webm) frame-by-frame.
        _run(["ffmpeg", "-y", "-i", audio_path, "-ac", "1", "-ar", "22050", wav22k], timeout=30)
        _run(["ffmpeg", "-y", "-i", audio_path, "-ac", "1", "-ar", "16000", wav16k], timeout=30)

        y, sr = librosa.load(wav22k, sr=22050, mono=True)
        duration = float(len(y) / sr)

        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(np.atleast_1d(tempo)[0])

        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
        key, key_confidence = _detect_key(chroma.mean(axis=1))
        dominant_chords = _detect_dominant_chords(chroma, beat_frames)

        instruments = _detect_instruments(wav16k, model_path, class_map_path)

    return {
        "success": True,
        "bpm": round(bpm, 1),
        "key": key,
        "keyConfidence": round(key_confidence, 3),
        "dominantChords": dominant_chords,
        "instruments": instruments,
        "durationSeconds": round(duration, 1),
        "error": None,
    }


if __name__ == "__main__":
    try:
        payload = json.load(sys.stdin)
        result = analyze(payload["audioPath"], payload["modelPath"], payload["classMapPath"])
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({
            "success": False, "bpm": None, "key": None, "keyConfidence": None,
            "dominantChords": [], "instruments": [], "durationSeconds": None,
            "error": str(e),
        }))
        sys.exit(1)
