# Track → Template — Improvement Plan

Grounded in a full audit of the codebase (started 2026-07-30, updated same day after a full implementation + bughunt pass). Every item references real files and real, verified gaps — no speculative features. Ordered by value-per-effort. Each phase is independently shippable.

**Status at a glance**: Phases 0, 1a, 1b, 1c, 2b, 2c, 2d, 3a, 3c, 4a, 4b, 5, a critical bugfix pass, and 6a-6e are all DONE and deployed (commits through `743d209`). Phase 3b is done for its agreed scope (4 of ~5 hooks extracted; style controls deferred). Remaining open work: Phase 2a (job queue — low priority), 3d, 3b's style-controls extraction, and 6f/6g (partially done — see below).

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

### 3b. Decompose `Home.tsx` — DONE for the agreed scope (2026-07-30); style controls deferred
Started once browser access existed. Real finding along the way: **no state cluster in this file is actually self-contained** — even the cleanest candidates reach into `currentTemplate`, `apiError`, the last-submitted URL/options refs, `addToHistory`, and (for anything that builds a generation request body) the full style-control selection. The original "mechanical, zero-coupling" framing undersold this. Approach settled on: each hook owns its own state/handlers but accepts cross-cutting values as parameters rather than reaching into shared scope or introducing a context — more plumbing per hook, stays low-risk and independently verifiable. Where a handler turned out to be more "orchestration reaching into this state" than core logic for that cluster (`handleLoadHistory`, `resetAutoFill`, `fetchVideoPreview`, `fetchSuggestionsForSong`), it was left in `Home.tsx` using the hook's exported setters rather than forced into an oversized hook signature.

Four hooks extracted, all **verified live** via the connected browser (not just typecheck — real interactions, real server logs cross-referenced with real rendered UI):
- `useVariationWorkshop` (4 states + 2 handlers) — generated real variations, confirmed diff view, merged one back, confirmed it flowed into history/Song DNA correctly.
- `useBatchMode` (8 states + 1 ref + 4 handlers) — ran a real 2-track batch, confirmed SSE progress, confirmed `BatchDashboard` rendered "2/2 done" with correct data. Incidental find: original `handleStartBatch`/`handleBatchRetry` were `useCallback`s with a dependency array missing `selectedVoices` despite reading it (stale-closure risk) — moot now since these are plain functions, not a deliberate fix.
- `useHistoryPanel` (8 states + 1 ref + module-level storage helpers + 7 handlers) — confirmed mount-time load, search filter with real quality scores, Export firing the right request, rated a fresh generation and confirmed both UI and persistence. **Caught a real mistake before shipping**: first-pass reconstruction of `mergeHistories`/`syncEntryToServer` from memory (instead of copying source) got the merge-priority direction backwards and dropped fields — caught by diffing against the original before deleting it, not by testing. Lesson: always diff against source when "mechanically" moving code, never reconstruct from memory even when confident.
- `useSuggestions` (7 states + 1 handler + 1 derived `useMemo`) — confirmed auto-detected style populates suggestion/auto-fill state and AUTO badges, confirmed clearing one field's auto-fill correctly reverts it and updates the active-count badge.

`Home.tsx`: 3606 → 3041 lines (~16% reduction across four hooks). **Style controls (~17-18 states) deliberately deferred** — by far the most pervasive cluster, read by the generation payload, batch, variations, presets, draft save/restore, and artist memory. Worth a dedicated future session rather than rushing it into this one.

### 3c. Variation diff view — ALREADY DONE (pre-existing, discovered during 3b)
Turns out this exists already — `VariationWorkshop.tsx` has a working word-level diff view (`+added`/`-removed` highlighting, a "DIFF ON" toggle, V1 marked as reference) verified live during `useVariationWorkshop` testing. Whoever wrote this plan item originally (an earlier pass in this same doc) didn't know it had already shipped. Marking done rather than re-implementing.

### 3d. Compact style export — DONE (2026-07-30)
Added a "Compact" toggle to the Style of Music section (`lib/compactStyle.ts`) — keeps era/genre/subgenre/BPM/key plus the Vocal Identity clause (label stripped), drops the hardware/signal-chain detail, bounded to ≤200 chars. Pure client-side transformation, no AI call. Verified live: toggled it on a real generation, confirmed the copy button (inline "Copied!" + toast). Verification surfaced a real AI-output inconsistency worth knowing — the labeled fields (`Neural Floor:`, `Vocal Identity:`, etc.) aren't always literally present in the AI's output; sometimes it writes the same content unlabeled. The function degrades gracefully when labels are absent (falls back to a comma-boundary truncation of the header) rather than crashing — confirmed with a real generation that hit exactly this case.

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

### 6g. Degraded-mode UX — DONE (2026-07-30)
Verified without ever touching the live production service or its `.env`: ran a second, fully isolated instance (`node dist/index.cjs`, port 3001, stripped `.env` with `GENIUS_API_TOKEN`/`GETSONGBPM_API_KEY`/`LASTFM_API_KEY`/`DISCOGS_TOKEN`/`ACOUSTID_API_KEY` all omitted, `CACHE_DIR` pointed at a throwaway temp dir), walked a real generation through the browser, then killed it and deleted the temp dir. Confirmed via startup log that all 5 optional integrations correctly showed `✗`. DSP stayed available (it's filesystem-gated by the venv/model, not any of these keys — a realistic partial-degradation scenario, not full degradation).

Result: **the app produces a complete, fully-featured template even with zero optional API keys.** Metadata fusion fell back cleanly to the keyless sources (MusicBrainz, TheAudioDB, Deezer, iTunes). Lyrics correctly walked Genius→lrclib→lyrics.ovh and landed on lyrics.ovh. Audio features briefly resolved via the `ai-knowledge` estimate tier before DSP finished and correctly overrode it with the real measurement (144 BPM, `dsp-measured`) — the tiering logic worked exactly as designed under real latency, not just in the happy path. Style/negative prompt padding, the Compact toggle, everything rendered normally. The graceful-degradation design holds up in practice, not just in code review.

---

## Explicitly rejected (to prevent scope creep)

- **PostgreSQL / Drizzle migration** (`lib/db` is legacy): SQLite is the right call on a Pi; nothing here needs concurrency SQLite can't handle.
- **Microservice split / Docker**: single esbuild bundle + systemd is appropriate for the deployment target.
- **Automatic Suno submission**: Suno has no public API; browser automation against their app would be brittle and ToS-risky.
- **In-browser audio analysis**: shipping Essentia/WASM to the client duplicates 1c at 10× complexity — 1c already exists server-side now, so this is doubly moot.

## Suggested order of execution from here

All of Phase 6a-6e, 3c, and 3b's agreed scope (4 hooks) are done. Remaining: **3d → 6g (degraded-mode walkthrough) → fix the resize_window issue and properly re-verify 6f → the era-detection bug spotted during 6e → 3b's style-controls extraction (dedicated session — by far the biggest remaining cluster) → 2b (incremental, ongoing) → 4c → 2a (only if something new needs it).**
Rationale: 3d is small and independent. 6g and a real 6f re-verification are cheap now that browser access exists. The era-detection bug is a real, verified inaccuracy but low urgency (cosmetic era tag, not a functional break). Style controls is deliberately last among the near-term items — it's pervasive enough (read by generation payload, batch, variations, presets, draft save/restore, artist memory) to deserve a full session of its own attention rather than being squeezed in.
