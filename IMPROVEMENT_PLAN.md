# Track → Template — Improvement Plan

Grounded in a full audit of the codebase (started 2026-07-30, updated same day after a full implementation + bughunt pass). Every item references real files and real, verified gaps — no speculative features. Ordered by value-per-effort. Each phase is independently shippable.

**Status at a glance**: Phases 0, 1a, 1b, 1c, 2b, 2c, 2d, 3a, 4a, 4b, 5, a critical bugfix pass, and Phase 6a-6e are all DONE and deployed (commits through `37b05cd`). Remaining open work is Phase 2a (job queue — low priority), Phase 3b/3c/3d (frontend UX), and 6f/6g (partially done — see below).

**Environment update (2026-07-30, same day)**: Claude in Chrome got connected mid-session (`google-chrome-stable` installed on the Pi itself — it does have a real ARM64 build now — plus a full LXDE desktop environment). Everything in Phase 6a-6e above was verified **live**, not just via typecheck/build: actual clicks, actual generations, actual server logs cross-referenced with actual rendered UI. This is a meaningfully more reliable verification bar than earlier phases in this doc, which relied on typecheck/build/grep only — worth knowing when weighing how much to trust older "DONE" markers vs these newer ones.

**Known testing limitation, still open**: window resize (`resize_window`) does not work in this environment — it reports success but `window.innerWidth` never actually changes (openbox/LXDE window-manager quirk on this specific Pi setup, not investigated further). This blocks live mobile-viewport screenshot testing. 6f below used code-level evidence instead (grepped for responsive Tailwind classes) since live testing wasn't possible — real signal, but not the same confidence level as an actual screenshot. If a future session gets window resize working (or tests from an actual phone on the LAN), re-verify 6f properly.

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

### 6a. DSP progress stage in the SSE stream — DONE
Added `"dsp-analysis"` to `GenerationStage`, emitted right before `analyzeAudioDsp()` runs, distinct message in `LoadingEq`. Verified live: 5 real generations against previously-unseen videos, confirmed via server logs that DSP genuinely ran each time (15-30s), confirmed the final rendered result correctly shows the "measured" badge, detected instruments, and dominant chords.

### 6b. Style prompt chronically undershoots its length target — DONE
Root cause confirmed: LLMs are unreliable at hitting exact character counts by instruction alone — the prompt already said "Fill to 900+ characters — do not stop short" explicitly, strengthening the wording further wasn't going to fix it reliably. Gave `validate_chars.py` real expansion logic for `styleOfMusic` (`pad_style_prompt()`, mirroring `pad_lyrics()`) — a rotating pool of generic-but-plausible mix/master engineering clauses appended until the target is reached. Verified live: a real generation that produced 781 chars was padded to 933 and correctly marked `ok=true`.

### 6c. Compress the logo asset — DONE
Actual file was `logotracktemplateBilde-...jpeg`, 5626×850px, 2.5MB, displayed at 56-64px tall. Re-encoded via `ffmpeg` to a 200px-tall WebP: 2.5MB → 36KB. Old file removed (confirmed nothing else referenced it). Verified visually live — after discovering the app's service worker serves a stale cached bundle across rebuilds (expected PWA behavior; unregister + clear caches + reload to see real current state when testing this app going forward).

### 6d. Code-split the frontend bundle — DONE
`React.lazy` + `Suspense` for `BatchDashboard`, `VariationWorkshop`, `AnalyticsDashboard`, `MultiTrackBuilder`, `TransitionBuilder` — none render on first paint. Main bundle: 1,110KB → 681KB (gzip 319KB → 203KB). `AnalyticsDashboard` alone split out to 386KB — likely a charting dependency that was bloating every page load regardless of whether the panel was ever opened. Verified live: fresh page load, no console errors, Analytics panel expands and renders correctly from its lazy chunk.

### 6e. Connect DSP data into `/api/suggest` when it already exists — DONE
Added optional `youtubeUrl` param; when the video's `features:{videoId}` cache already holds `dsp-measured` data, real measurements now win over the AI guess: `bpmToTempoBucket()` for tempo, `mapDspInstrumentsToSuggestVocab()` for instruments (YAMNet's AudioSet labels don't match `/suggest`'s `INSTRUMENT_LIST` 1:1 — e.g. `"Drum machine"` → `"808"` — labels with no reasonable equivalent are dropped, not guessed at). Never triggers new analysis from `/suggest` itself. New `lib/dspSuggestionMapping.ts` + `.test.ts` (7 tests). Verified live: a video with real cached data (172 BPM, top instrument "Drum machine") produced `tempo: "hyper"` and instruments led by `808,Drums,Synth,Bass,Acoustic Guitar`, log line confirms `dsp-measured data used`.

**Bug spotted along the way, not fixed (out of scope for 6e)**: `/suggest` returned `era: "2000s"` for a-ha's "Take On Me" (actually 1985). Unrelated to DSP — era comes from MusicBrainz year lookup or AI guessing, not measured. Worth its own investigation.

### 6f. Mobile responsiveness — PARTIALLY DONE (code-level only, live testing blocked)
Live mobile-viewport screenshot testing is blocked by the `resize_window` issue noted above. Fell back to code-level evidence: only 8 total responsive-prefix (`sm:`/`md:`/`lg:`/`xl:`) Tailwind classes exist across the entire 3,400-line `Home.tsx`. Concretely, `grid grid-cols-2 gap-4` (Vocals/Energy and Tempo/Era sections, `Home.tsx:2440` and `:2476`) has no responsive override to collapse to a single column on narrow screens — real evidence of a likely rough edge on phone-width viewports, though not visually confirmed. Chip/tag grids (genres, moods, instruments) use flexbox wrap without explicit breakpoints, which likely degrades more gracefully. **Re-verify with an actual screenshot once window resize works, or test from a real phone on the LAN** — this write-up is inference from code, not observation.

### 6g. Degraded-mode UX — still not done
What does the app actually look/feel like with no optional API keys configured and DSP unavailable? Every source fails gracefully server-side (confirmed in code), but the *user-facing* experience of an all-estimates, no-DSP, no-Genius run has never been walked through end-to-end. Would require temporarily unsetting keys on the live service and restarting — deferred rather than doing that unprompted to a running production box.

---

## Explicitly rejected (to prevent scope creep)

- **PostgreSQL / Drizzle migration** (`lib/db` is legacy): SQLite is the right call on a Pi; nothing here needs concurrency SQLite can't handle.
- **Microservice split / Docker**: single esbuild bundle + systemd is appropriate for the deployment target.
- **Automatic Suno submission**: Suno has no public API; browser automation against their app would be brittle and ToS-risky.
- **In-browser audio analysis**: shipping Essentia/WASM to the client duplicates 1c at 10× complexity — 1c already exists server-side now, so this is doubly moot.

## Suggested order of execution from here

All of Phase 6a-6e are done. Remaining: **3b (browser access now exists — do this first, it's the prerequisite for 3c/3d) → 3c → 3d → 6g (degraded-mode walkthrough) → fix the resize_window issue and properly re-verify 6f → the era-detection bug spotted during 6e → 2b (incremental, ongoing) → 4c → 2a (only if something new needs it).**
Rationale: 3b was explicitly deferred earlier for lack of browser access — that blocker is gone, and it's still the right prerequisite for 3c/3d per the original ordering logic (a cleaner `Home.tsx` base before adding more UX to it). 6g and a real 6f re-verification are cheap now that browser access exists. The era-detection bug is a real, verified inaccuracy but low urgency (cosmetic era tag, not a functional break).
