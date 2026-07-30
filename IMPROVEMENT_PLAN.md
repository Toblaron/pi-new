# Track → Template — Improvement Plan

Grounded in a full audit of the codebase (2026-07-30). Every item references real files and real, verified gaps — no speculative features. Ordered by value-per-effort. Each phase is independently shippable.

---

## Phase 0 — Housekeeping (½ session)

Zero-risk cleanups that make everything after easier.

1. **Delete root junk**: `1784518187396-player-script.js`, `1784518187410-player-script.js`, `1785023898475-player-script.js`, `1785023898489-player-script.js` — untracked download debris at repo root. *(Confirm they're not referenced anywhere first: `grep -r "player-script" --include="*.ts*"`.)*
2. **Commit CLAUDE.md** (revised) and the `.claude/CLAUDE.md` pointer — both were untracked, so the guide wasn't versioned at all.
3. **Add `.gitignore` entries** if missing for `data/*.db`, `.env`, `dist/`.
4. **Tighten CORS**: `app.ts:51` uses `cors()` wide open. For a LAN Pi deployment this is acceptable, but an env-driven allowlist (`CORS_ORIGIN`) is one line and removes a class of drive-by-browser risk.

---

## Phase 1 — Make the numbers real (highest-value improvement)

**The core weakness of the tool today**: BPM/key come from description regex → GetSongBPM → *AI guessing* (`lib/audioFeatures.ts`), and the "confidence" score is asserted, not measured. Meanwhile `lib/acoustid.ts` — a complete, working fpcalc/AcoustID fingerprinting module — is imported by **nothing**. The best single upgrade is grounding the template in verified data.

### 1a. Deezer as a free BPM source (~½ session, no key required)
Deezer's public API (`https://api.deezer.com/search?q=artist:"X" track:"Y"`) needs no API key and its track objects include a `bpm` field (0 when unknown) plus `gain` and release data. Add `lib/deezer.ts` modeled on `lib/lastfm.ts`, feed it into `fuseMetadata()` in `lib/metadataFusion.ts` as another BPM/year source. The existing `bpmConfident` "2+ sources agree within ±2" logic (`metadataFusion.ts`) immediately gets stronger. *Verify the field is populated for a few test tracks before wiring; treat `bpm: 0` as absent.*

### 1b. Wire up the dormant AcoustID pipeline (~1 session)
`lib/acoustid.ts` already implements fpcalc execution and AcoustID lookup. What's missing:
- `apt install libchromaprint-tools` on the Pi (provides `fpcalc`); free AcoustID API key → `ACOUSTID_API_KEY` env.
- A small `lib/audioDownload.ts`: stream ~120s of audio-only via `@distube/ytdl-core` (already a dependency, already used for metadata) to a temp file, return the path, always clean up.
- Call it in `fetchBaseMetadata()` (`routes/suno.ts:520`) **only when title/artist cleanup looks unreliable** (e.g. `cleanSongTitle` produced no artist split, or MusicBrainz search returned nothing). Result: verified artist/title/MBID → exact MusicBrainz lookup instead of fuzzy text search. This is the fix for remixes, re-uploads, and "Nightcore – xyz" videos where the whole pipeline currently derails.
- Gate the entire path behind `ACOUSTID_API_KEY` being set + `fpcalc` existing (check once at startup, log clearly).

**Risk to plan around**: server-side YouTube audio download is subject to YouTube bot detection/throttling — keep it best-effort with a hard timeout, never on the critical path, and cache the result permanently per videoId.

### 1c. Real DSP tempo/key analysis as a background job (~2 sessions)
Once 1b downloads audio anyway, actual measurement becomes possible:
- **Tempo**: `aubio` CLI (`apt install aubio-tools`, `aubio tempo file.wav`) — light enough for a Pi.
- **Key**: `keyfinder-cli` (may need building) or a small Python script with `librosa` (heavier; acceptable in a background job).
- Run it via the **existing** `lib/jobQueue.ts` (see Phase 2a) so a slow analysis never blocks a request. On completion, overwrite the permanent `features:{videoId}` cache entry with `source: "dsp", confidence: 0.95` — the next generation for that track uses measured values.
- `SongDnaPanel.tsx` already displays feature source — measured values will be visibly distinguished with no frontend work.

---

## Phase 2 — Finish the half-built systems

### 2a. Job-queue worker (~1 session)
`lib/jobQueue.ts` creates the table and `routes/admin.ts` exposes `claimNextJob` — but no worker exists, so nothing ever runs. Add an in-process worker in `artifacts/api-server/src/index.ts`: a `setInterval` loop that claims one pending job at a time (SQLite claim is already transactional via `claimNextJob`) and dispatches to registered handlers (`audio-analysis` from 1c is the first customer). Add `GET /api/jobs/:id` for status polling. Single-process, no new infrastructure — appropriate for a Pi.

### 2b. Close the OpenAPI drift (~2 sessions, incremental)
`openapi.yaml` describes 2 of ~30 endpoints; `Home.tsx` contains 17 hand-typed `fetch()` calls whose request/response types can silently drift from the server. Plan:
1. Spec the highest-traffic endpoints first: `/suggest`, `/youtube-preview`, `/history` (all verbs), `/generate-variations`, `/pre-analyze-structure`.
2. `pnpm --filter @workspace/api-spec run codegen` after each batch.
3. Migrate the corresponding `fetch()` calls in `Home.tsx` to the generated React Query hooks + Zod schemas — one endpoint per commit, verifiable in isolation.
4. Use the generated Zod schemas to **validate request bodies server-side** too (several routes hand-roll validation today).

SSE endpoints (`/batch`) stay outside the spec — document them in a comment block.

### 2c. Server-side feedback loop (~1 session)
`generate-template` accepts a client-supplied `feedbackContext` string built from past ratings. Move this server-side: on each generation, query the history table for this track's genre-neighbors rated ≥4 and ≤2, extract recurring style-prompt tags, and build the context in `routes/suno.ts`. More trustworthy (client can't send junk), works from every client, and enables 2d.

### 2d. Tag-effectiveness scoring (~1 session)
`artifacts/api-server/src/data/sunoTagDictionary.json` grades style tags, and history entries carry both the generated `styleOfMusic` and a star rating. Add a small aggregation (`lib/tagStats.ts`): tokenize style prompts of rated templates, compute average rating per tag, expose via `GET /api/tags/stats`. Surface in `AnalyticsDashboard.tsx` ("your highest-rated templates use: …") and feed the top personal tags into 2c's feedback context. This converts the existing rating feature from decoration into a learning loop.

---

## Phase 3 — UX upgrades

### 3a. Live progress for single generation (~1 session)
`/api/batch` already streams SSE (`routes/suno.ts:1699`) — but the primary single-track flow shows only a spinner during a pipeline that makes 6+ network calls plus an AI call. Add `POST /api/generate-template/stream` (SSE, same pattern as batch): give `generateOneTemplate` an optional `onStage(stage: string)` callback and emit `metadata → sources → lyrics (via genius/lrclib/…) → ai-generating → validating → done`. Frontend: reuse the batch SSE parsing already in `Home.tsx`, render stages in `LoadingEq`. Keep the existing JSON endpoint untouched for compatibility.

### 3b. Decompose `Home.tsx` (~2 sessions, zero behavior change)
3,368 lines and 60+ `useState` in one component is where future bugs will come from. Extract by feature into custom hooks — state that already clusters cleanly: `useHistoryPanel` (7 states), `useBatchMode` (8), `useVariationWorkshop` (4), `useStyleControls` (~14), `useSuggestions` (5). Move each hook + its fetch logic to `src/hooks/`. Mechanical, verifiable with `pnpm run typecheck` + manual smoke test per extraction. Do this **before** any major frontend feature work.

### 3c. Variation diff view (~½ session)
`VariationWorkshop.tsx` renders 2–4 variations side by side. Add a word-level diff highlight of each variation's style prompt against the base template (small pure function, no deps needed) so the user sees *what actually changed* instead of re-reading 999 characters.

### 3d. Compact style export (~½ session)
The template targets 900–999 style chars (Suno v4.5+ limit). Add a "compact" toggle in `TemplateResult.tsx` that produces a ≤200-char condensation (client-side: keep era/genre/BPM/key/vocal identity, drop the hardware chain) for use with older Suno versions or other tools. Pure string transformation — no AI call.

---

## Phase 4 — Safety net (do alongside everything above)

### 4a. Unit tests with vitest (~1 session to establish, then ongoing)
The repo has **zero tests**, yet is full of pure, high-blast-radius functions that are trivially testable with no mocks:
- `routes/suno.ts`: `cleanSongTitle` (the function everything downstream depends on), `parseDescriptionForMusicData`, `trimStylePrompt`, `videoIdFromUrl` / `isValidYouTubeUrl`, `yearToEra`, `mapMbTagsToGenres`, the `infer*` family.
- `lib/metadataFusion.ts`: `fuseMetadata` (BPM consensus, mood filtering).
- `lib/lyricsStructure.ts`, `lib/fingerprint.ts`, `lib/suggestedDefaults.ts`.

Add `vitest` to `artifacts/api-server`, a root `pnpm test` script, and seed ~30 cases (especially `cleanSongTitle` against real-world YouTube title patterns: "Artist - Song (Official Video)", "Song [Lyrics]", "Nightcore – X", topic channels). Testing may require exporting these helpers or moving them to `lib/` — which dovetails with 4b.

### 4b. Split `routes/suno.ts` (~2 sessions, after 4a exists to catch regressions)
2,898 lines. Natural seams already visible in the code: `lib/youtubeMetadata.ts` (oEmbed/ytdl/captions/title-cleanup), `lib/lyricsProviders.ts` (Genius/lrclib/ovh), `lib/promptBuilder.ts` (buildPromptContext/buildStyleControls/trim helpers), `routes/generate.ts`, `routes/tools.ts` (transform/reverse/mood/transition/multi-track). Pure moves, no logic changes. *(Note: CLAUDE.md rule 3 mandates surgical edits — this phase is the explicit instruction to refactor.)*

### 4c. Integration tests for history routes (~½ session)
`supertest` against the Express app with `CACHE_DIR` pointed at a temp dir — the history/share/collection CRUD in `routes/history.ts` is self-contained SQLite, ideal for cheap integration coverage.

---

## Phase 5 — Smaller clever additions (grab-bag, ~½ session each)

- **Artist-name scrub**: Suno rejects/ignores real artist names in style prompts. Add a post-generation pass in the Python validator step that strips the detected artist name from `styleOfMusic` (it's known from metadata) — protects against the AI leaking it in.
- **iTunes Search API** as another keyless genre/year source for `metadataFusion` (`https://itunes.apple.com/search?term=…&media=music`, no auth).
- **User-facing cost panel**: `costTracker` + `GET /api/admin/usage` already aggregate token spend per model — surface a small read-only "AI usage this week" card in `AnalyticsDashboard.tsx` (new unauthed endpoint returning totals only).
- **Startup self-check**: one log block at boot reporting which optional integrations are live (Genius token? GetSongBPM? Last.fm? Discogs? fpcalc present? python3 present?) — currently sources fail silently per-request, which makes "why are my templates generic?" hard to debug.
- **`/api/healthz` enrichment**: include DB reachable, python3 available, AI endpoint configured — makes the systemd/DietPi deployment (see `scripts/`) genuinely monitorable.

---

## Explicitly rejected (to prevent scope creep)

- **PostgreSQL / Drizzle migration** (`lib/db` is legacy): SQLite is the right call on a Pi; nothing here needs concurrency SQLite can't handle.
- **Microservice split / Docker**: single esbuild bundle + systemd is appropriate for the deployment target.
- **Automatic Suno submission**: Suno has no public API; browser automation against their app would be brittle and ToS-risky.
- **In-browser audio analysis**: shipping Essentia/WASM to the client duplicates Phase 1c at 10× complexity.

## Suggested order of execution

**0 → 1a → 4a → 3a → 2c → 2d → 1b → 2a → 1c → 3b → 2b → 4b → rest.**
Rationale: 1a and 4a are cheap and de-risk everything; 3a is the most user-visible win; the feedback loop (2c+2d) compounds the longer it runs, so start it early; audio download (1b/1c) has the most external risk, so land it behind flags once the safety net exists.
