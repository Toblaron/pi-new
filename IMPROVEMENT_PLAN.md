# Track → Template — Improvement Plan

Grounded in a full audit of the codebase (started 2026-07-30, updated same day after a full implementation + bughunt pass). Every item references real files and real, verified gaps — no speculative features. Ordered by value-per-effort. Each phase is independently shippable.

**Status at a glance**: Phases 0, 1a, 1b, 1c, 2b, 2c, 2d, 3a, 4a, 4b, 5, and a critical bugfix pass are all DONE and deployed (commits through `87beec9`). Remaining open work is Phase 2a (job queue — low priority now), Phase 3b/3c/3d (frontend UX), and the new Phase 6 polish list below, which is the current priority.

**Environment note for whoever picks this up next**: no browser-testing tool was available for this entire session — every frontend change was verified via typecheck + production build + bundle-content grep only, never interactively clicked. `/chrome` (Claude in Chrome extension) was checked and is not connected. If you have browser access, prioritize re-verifying the frontend items below (3b especially) with actual interaction before trusting them further, and do a real mobile-viewport pass — that has never been checked at all.

---

## Phase 0 — Housekeeping — DONE

Deleted root debris (`*-player-script.js` files), committed `CLAUDE.md` (was untracked), confirmed `.gitignore` covers `data/*.db`/`.env`/`dist/`. CORS tightening (`CORS_ORIGIN` allowlist) was **not** done — still wide open via `cors()` in `app.ts`; acceptable for a LAN Pi deployment but worth revisiting if this is ever exposed beyond the LAN/Tailscale.

---

## Phase 1 — Make the numbers real — DONE

### 1a. Deezer as a free BPM source — DONE
`lib/deezer.ts` added, wired into `fuseMetadata()`.

### 1b. Wire up the dormant AcoustID pipeline — DONE
`ACOUSTID_API_KEY` set and validated live, `fpcalc` installed, `lib/audioDownload.ts` built (originally on `@distube/ytdl-core`, later migrated to `yt-dlp` — see below), wired into `fetchBaseMetadata()` as a fallback when title-based MusicBrainz search finds nothing.

### 1c. Real DSP tempo/key/chord/instrument analysis — DONE (2026-07-30)
Implemented once the YouTube CDN block cleared (new router/IP) and `@distube/ytdl-core`'s
broken stream extraction was replaced with `yt-dlp` for downloads. Spike-tested on the actual
Pi 5 before committing to the approach — real numbers, not estimates:

- **Stack**: `artifacts/api-server/.venv-audio` (gitignored, ~550MB, `requirements-audio.txt`) —
  `numpy`/`scipy`/`librosa`/`soundfile` install as clean prebuilt ARM64 wheels, no compilation.
  `ffmpeg` installed system-wide via apt (needed for fast format decode — librosa's fallback
  decoder is ~8x slower without it). `ai-edge-litert` (Google's actively-maintained TFLite
  successor; `tflite-runtime` has no current wheel) runs YAMNet, a 16MB pretrained AudioSet
  classifier (`data/models/yamnet.tflite` + `yamnet_class_map.csv`, gitignored, fetched once).
- **Tempo**: `librosa.beat.beat_track` — measured 112.3 BPM on a known ~113 BPM test track.
- **Key**: Krumhansl-Schmuckler profile correlation (24 candidate keys) against beat-averaged
  chroma (`chroma_cqt`) — classical technique, no ML model needed.
- **Chords**: per-beat chroma vs. 24 major/minor triad templates. Raw per-beat labels flicker
  almost every beat on real audio (verified empirically — not musically plausible), so this is
  median-smoothed and reported as **dominant chords by time-share**, not a bar-by-bar
  progression. Honest about the limitation: no 7ths/extensions/inversions.
- **Instruments**: YAMNet inference, **peak** (not mean) score per class — mean is dominated by
  genre/mood classes ("Music", "Pop music") that share YAMNet's 521-class space with actual
  instruments; peak surfaces real but brief instrumental bursts. Filtered to a curated ~50-label
  instrument subset. Verified against a known track: correctly flagged `Synthesizer`/`Drum
  machine` (peaks 0.22/0.27), correctly stayed silent on absent instruments (no guitar/piano
  false positives).
- **Pipeline**: `analyze_audio.py` (spawned like `validate_chars.py`, JSON in/out) →
  `lib/dspAnalysis.ts` → wired into `generateOneTemplate`'s Stage 2 in `routes/suno.ts`. Runs
  **synchronously, blocking**, only on a genuine cache miss for `source !== "dsp-measured"` —
  the permanent `features:{videoId}` cache means this is a one-time ~10-15s cost per song, never
  repeated. `/pre-analyze-structure`'s opportunistic cache warm stays on the fast estimate chain
  only (never triggers DSP) so the paste-preview flow stays instant.
- **Known inefficiency, not fixed**: if a video both needs the AcoustID fallback (messy title)
  and is a first-time DSP analysis, audio is downloaded twice in the same request (~3-5s extra).
  Rare combination; not worth the cross-function temp-file-lifetime complexity to fix.
- Surfaced in `TemplateResult.tsx`'s header badge (key/BPM/instruments/dominant chords, all
  honestly labeled "measured" vs the estimate tiers' existing "estimated" framing) and in the
  `AudioFeatures` OpenAPI schema (`source: dsp-measured`, `dominantChords`, `instruments`).
- **Gap left open, see 6a below**: the ~10-15s blocking wait has no SSE progress stage — the
  live-progress system built in 3a doesn't know DSP analysis exists yet.

---

## Phase 2 — Finish the half-built systems

### 2a. Job-queue worker — NOT DONE, now lower priority
`lib/jobQueue.ts` creates the table and `routes/admin.ts` exposes `claimNextJob`, but no worker exists. This was originally planned as the execution mechanism for 1c (background DSP analysis) — but 1c shipped as **synchronous/blocking** instead (explicit user choice: simpler code, one-time cost, acceptable wait). So the queue still has no real consumer. Only worth building now if something else needs async background work (e.g. batch-generating a large playlist without holding open connections), not as a prerequisite for anything currently planned.

### 2b. Close the OpenAPI drift — PARTIALLY DONE
`openapi.yaml` now covers `/healthz`, `/generate-template`, `/generate-variations`, `/playlist-info`, `/batch`, `/suno/transform` (was 2 endpoints, now 6). Remaining ~24 endpoints (`/suggest`, `/youtube-preview`, `/history` CRUD, `/pre-analyze-structure`, `/multi-track`, `/reverse`, `/mood-to-settings`, admin routes, etc.) still use hand-typed `fetch()` + local types in `Home.tsx`. Worth continuing incrementally, highest-traffic endpoints first, same pattern as before.

### 2c. Server-side feedback loop — DONE
### 2d. Tag-effectiveness scoring — DONE

---

## Phase 3 — UX upgrades

### 3a. Live progress for single generation — DONE
`POST /api/generate-template/stream` (SSE) ships `metadata → lyrics → ai-generating → validating → done`. **Now stale against 1c** — see 6a, the DSP step added inside the `metadata`→`lyrics` gap has no stage of its own.

### 3b. Decompose `Home.tsx` — NOT DONE
Still ~3,400 lines, 60+ `useState`. Deliberately **not attempted this session** — mechanical extraction is exactly the kind of change that's easy to get subtly wrong (stale closures, effect-dependency changes) and needs real click-through verification per extraction, which required a browser tool that wasn't available. Do this first once browser access exists — it's explicitly a prerequisite for doing any further frontend feature work safely, per the original plan's ordering.

### 3c. Variation diff view — NOT DONE
`VariationWorkshop.tsx` still renders variations with no highlight of what changed vs. the base template.

### 3d. Compact style export — NOT DONE
No ≤200-char condensed-style toggle yet for older Suno versions.

---

## Phase 4 — Safety net — DONE

### 4a. Unit tests with vitest — DONE
118 tests across 12 files as of the last commit (started at 0, grew through 110, +8 today from the bugfix pass). `pnpm --filter @workspace/api-server run test`.

### 4b. Split `routes/suno.ts` — DONE
Split from ~3,001 → ~2,300 lines via extraction to `lib/musicbrainz.ts`, `lib/lyricsProviders.ts`, `lib/genreInference.ts`, `lib/promptBuilder.ts`.

### 4c. Integration tests for history routes — NOT DONE
Still no `supertest`-based coverage for `routes/history.ts`'s CRUD.

---

## Phase 5 — Smaller clever additions — DONE
Artist-name scrub, iTunes Search API source, startup self-check, `/api/healthz` enrichment all shipped. User-facing cost panel in `AnalyticsDashboard.tsx` was **not** done — `costTracker`/`/api/admin/usage` data exists server-side but has no unauthenticated summary endpoint or UI card yet.

---

## Bugfix pass — DONE (2026-07-30, commit `87beec9`)

Triggered by a "Language detected: Russian/Korean" anomaly noticed in production logs for English/Spanish songs. Traced to real data corruption, not a detection quirk:

- **Critical**: Genius's page wraps a "N Contributors" credit + language-translations dropdown *inside* the actual lyrics container, marked `data-exclude-from-selection="true"` (their own signal that copy/paste should skip it — the scraper never respected that). Its content — including translated language names in their own script — was leaking directly into lyrics text sent to the AI on every successful Genius fetch. Fixed in `lyricsProviders.ts`, verified against a real fetched Genius page.
- HTML entity leaks (`&#x27;` etc. not decoded) at 4 scrape sites, consolidated into `lib/htmlEntities.ts`.
- Leaked temp files on failed/timed-out `yt-dlp` downloads (tmpfs RAM leak on long uptime, not disk-filling). Fixed in `audioDownload.ts`.
- 8 new regression tests added for all of the above.

---

## Phase 6 — Polish pass (current priority, added 2026-07-30)

Grounded in verified findings, not speculation — each item below was checked against real logs/code before being listed.

### 6a. DSP progress stage in the SSE stream (~small)
`GenerationStage` in `routes/suno.ts` is `"metadata" | "lyrics" | "ai-generating" | "validating" | "done"` — the ~10-15s blocking DSP analysis (1c) happens between the `metadata` and `lyrics` stages with no stage of its own. During that wait the UI shows no change, which reads as hung. Add a `"dsp-analysis"` stage, emit it right before `analyzeAudioDsp()` is called, and give it a distinct message in the frontend's `LoadingEq`/stage renderer (e.g. "Analyzing real audio — tempo, key, instruments…").

### 6b. Style prompt chronically undershoots its length target (~small-medium)
Verified: checked the last 6 hours of production logs, 4 of 5 generations landed *below* the 900-999 char `styleOfMusic` target (775-850 chars). `validate_chars.py` has real padding logic for `lyrics` when it's too short, but `styleOfMusic`/`negativePrompt` just get flagged `"styleOfMusic too short after padding: N chars (need 900–999)"` as an **unfixable** error and shipped short anyway. Two possible fixes, not mutually exclusive: (1) strengthen the AI prompt instruction with an explicit minimum-character reminder and maybe a retry-once-if-short loop before falling to the Python validator, or (2) give the Python validator real expansion logic for `styleOfMusic` (append additional real production-detail clauses, same spirit as the lyrics padding pool) instead of just flagging the shortfall.

### 6c. Compress the logo asset (~trivial)
`artifacts/suno-generator/src/assets/logo-track-template.jpg` is 2.5MB, shipped uncompressed to every visitor. Convert to WebP or re-encode at reasonable quality/dimensions — should land well under 200KB with no visible difference at the sizes it's actually displayed.

### 6d. Code-split the frontend bundle (~small-medium)
Every production build warns `dist/public/assets/index-*.js  1,110.44 kB │ gzip: 319.57 kB` exceeds the 500kB chunk-size guidance — this has been true throughout the session and was never addressed. Candidates for `dynamic import()`: `BatchDashboard`, `AnalyticsDashboard`, `VariationWorkshop`, `MultiTrackBuilder`, `TransitionBuilder` — all secondary views not needed on first paint.

### 6e. Connect DSP data into `/api/suggest` when it already exists (~medium)
`/api/suggest` (used for the UI's suggested style controls right after pasting a link) guesses `instruments`/`tempo` purely via AI, even for videos that already have real `dsp-measured` data sitting in the permanent `features:{videoId}` cache from a prior generation. It structurally can't check — it only takes `title`/`artist` query params, no video ID. Needs a signature change (`youtubeUrl` or `videoId` optional param) plus a mapping table from YAMNet's raw AudioSet instrument labels to `/suggest`'s constrained `INSTRUMENT_LIST` vocabulary (they don't match 1:1 — e.g. `"Drum machine"`/`"Sampler"` vs. the UI's `"808"`/`"Synth"`). Do **not** trigger new DSP analysis from `/suggest` itself — it must stay fast for the paste-preview flow; only use data that's already cached.

### 6f. Mobile responsiveness — untested, unknown state
Never verified in an actual browser at a mobile viewport this session. Do this once browser access exists, before claiming any UX polish is complete.

### 6g. Degraded-mode UX — untested, unknown state
What does the app actually look/feel like with no optional API keys configured and DSP unavailable? Every source fails gracefully server-side (confirmed in code), but the *user-facing* experience of an all-estimates, no-DSP, no-Genius run has never been walked through end-to-end.

---

## Explicitly rejected (to prevent scope creep)

- **PostgreSQL / Drizzle migration** (`lib/db` is legacy): SQLite is the right call on a Pi; nothing here needs concurrency SQLite can't handle.
- **Microservice split / Docker**: single esbuild bundle + systemd is appropriate for the deployment target.
- **Automatic Suno submission**: Suno has no public API; browser automation against their app would be brittle and ToS-risky.
- **In-browser audio analysis**: shipping Essentia/WASM to the client duplicates 1c at 10× complexity — 1c already exists server-side now, so this is doubly moot.

## Suggested order of execution from here

**6a → 6c → 6b → 6d → 3b (once browser access exists) → 3c → 3d → 6e → 2b (incremental, ongoing) → 6f/6g (verification, needs browser) → 4c → 2a (only if something new needs it).**
Rationale: 6a/6c are small, high-visibility, zero-risk wins — do them first. 6b is a real data-quality bug worth fixing before more feature work sits on top of it. 3b should happen before any further `Home.tsx` UX work (3c, 3d) so those land on a cleaner base, but needs browser verification first — everything before it in this list doesn't. 6e is the biggest single item and depends on nothing else being done first, so it can slot in whenever there's a free session.
