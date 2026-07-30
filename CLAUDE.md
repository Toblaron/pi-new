# CLAUDE.md — Track -> Template Codebase Guide

Token-efficient architectural map, command reference, and rule guide for Claude Code in this repository.

---

## 1. Project Overview & Architecture

**Track -> Template** is a TypeScript `pnpm` monorepo that converts YouTube song links into structured [Suno.ai](https://suno.ai) prompt templates ("SONIC ARCHITECT" format: 900–999 char style prompt, title, 150–199 char negative prompt, 4,900+ char structured lyrics block).

### Core Stack
- **Frontend**: React 18, Vite, Tailwind CSS, React Query (`artifacts/suno-generator`)
- **Backend**: Express 5, Node.js, esbuild, `@distube/ytdl-core` (`artifacts/api-server`)
- **Database / Cache**: SQLite (`better-sqlite3`) at `./data/suno-cache.db` (cache, history, shares, job queue, usage log)
- **AI Integration**: OpenAI SDK-compatible wrapper (Google Gemini OpenAI endpoint, Groq, or OpenAI). `AI_MODEL` for generation, `AI_MINI_MODEL` for lightweight calls (suggest, reverse, transform). Token usage logged to SQLite via `costTracker`.
- **API Spec & Types**: OpenAPI 3.1 (`lib/api-spec/openapi.yaml`) with Orval codegen. ⚠️ The spec currently covers only `/healthz` and `/generate-template`; all other endpoints are hand-typed `fetch()` calls in the frontend.
- **Python**: `artifacts/api-server/src/validate_chars.py` (spawned by `pythonValidator.ts`) enforces/pads field character limits after every AI generation. Requires `python3` on PATH.
- **yt-dlp**: `lib/audioDownload.ts` shells out to the `yt-dlp` binary (must be on PATH) to fetch a short audio sample for AcoustID fingerprinting and DSP analysis. `@distube/ytdl-core` can no longer extract playable stream URLs (its decipher logic is broken against YouTube's current player) and is only used elsewhere for metadata (`getInfo`/`getBasicInfo`), not byte downloads.
- **DSP analysis**: `src/analyze_audio.py`, run in an isolated venv (`artifacts/api-server/.venv-audio`, gitignored — `numpy`/`scipy`/`librosa`/`soundfile`/`ai-edge-litert`, see `requirements-audio.txt`) via `lib/dspAnalysis.ts`. Measures real tempo (librosa beat tracking), key (Krumhansl-Schmuckler chroma correlation), dominant chords (beat-synced chroma vs. triad templates, median-smoothed, reported as time-weighted dominant chords — not a bar-by-bar progression), and instrument tags (YAMNet TFLite classifier, peak score per class, filtered to a curated instrument subset — see `data/models/yamnet.tflite`, gitignored). Requires `ffmpeg` on PATH.

### Generation pipeline (`generateOneTemplate` in `routes/suno.ts`)
1. **Base metadata** (7d cache): YouTube oEmbed → ytdl-core enrichment (description, keywords, captions, duration) → title/artist cleanup → MusicBrainz + Last.fm + Discogs + TheAudioDB fetched in parallel → `metadataFusion` merges genres/moods/BPM/key/year with confidence.
2. **Audio features** (permanent cache): tiered — description regex → GetSongBPM API → AI-knowledge fallback → **real DSP measurement** (`dspAnalysis.ts`/`analyze_audio.py`, the highest-confidence tier, `source: "dsp-measured"`). DSP runs synchronously on the first generation for a video (once the venv/model are present — see `checkDspAnalysisAvailable()`) and permanently upgrades the cache; every source below `dsp-measured` is a text-based estimate, not a measurement.
3. **Lyrics** (7d cache): Genius scrape → lrclib → lyrics.ovh → YouTube captions fallback; manual user override supported.
4. Structure analysis, suggested defaults, style controls → **single AI call** (delimited plain-text format, no JSON mode) → Python validator trims/pads fields to spec → fingerprint ("Song DNA") computed → template cache (keyed videoId + params hash).

---

## 2. Essential Commands

Package manager is strictly **`pnpm`**.

```bash
pnpm install

# Type checking (TypeScript project references)
pnpm run typecheck
pnpm run typecheck:libs

# Codegen (re-generate API client & Zod schemas from openapi.yaml)
pnpm --filter @workspace/api-spec run codegen

# Development mode
pnpm --filter @workspace/api-server run dev     # Express API server
pnpm --filter @workspace/suno-generator run dev # Vite frontend dev server

# Production Build & Run
pnpm run build:prod   # Builds frontend assets & esbuild backend
pnpm run start:prod   # Backend serving API + static frontend
# Or manually:
NODE_ENV=production node --env-file=.env artifacts/api-server/dist/index.cjs
```

There are currently **no automated tests** in the repo.

---

## 3. Directory Layout & Workspace Map

```text
.
├── artifacts/
│   ├── api-server/              # Express 5 backend (built via esbuild → dist/index.cjs)
│   │   └── src/
│   │       ├── index.ts         # Server entry point (starts Express on PORT)
│   │       ├── app.ts           # CORS, in-memory IP rate limiting, static serving (prod)
│   │       ├── validate_chars.py# Field length validator/padder (spawned per generation)
│   │       ├── data/sunoTagDictionary.json  # Graded Suno style-tag dictionary
│   │       ├── routes/
│   │       │   ├── index.ts     # Router aggregator
│   │       │   ├── suno.ts      # CORE generation logic (~2,900 lines: metadata, lyrics, prompts, all generation endpoints)
│   │       │   ├── history.ts   # History CRUD, collections, export, ratings, share links
│   │       │   ├── admin.ts     # ADMIN_KEY-protected: health, usage stats, DB backup, tag dictionary, job claim
│   │       │   └── health.ts    # GET /healthz
│   │       └── lib/
│   │           ├── cache.ts           # SQLite init + TTL cache helpers (exports shared `db`)
│   │           ├── historyStore.ts    # History & share tables
│   │           ├── audioFeatures.ts   # BPM/key via description parse / GetSongBPM / AI knowledge
│   │           ├── lyricsStructure.ts # Lyrics section breakdown
│   │           ├── fingerprint.ts     # "Song DNA" derived from metadata (not audio)
│   │           ├── metadataFusion.ts  # Merges MusicBrainz/Last.fm/Discogs/TheAudioDB data
│   │           ├── lastfm.ts / discogs.ts / theaudiodb.ts  # External metadata sources
│   │           ├── acoustid.ts        # fpcalc/AcoustID fingerprinting — wired as a fallback in fetchBaseMetadata; no-ops without ACOUSTID_API_KEY (unset by default)
│   │           ├── audioDownload.ts   # Downloads a short audio sample via the yt-dlp binary, for acoustid.ts
│   │           ├── jobQueue.ts        # SQLite job queue — ⚠️ table + enqueue/claim functions exist, but nothing calls enqueueJob and no HTTP route or worker consumes it; fully disconnected
│   │           ├── costTracker.ts     # AI token usage log (usage_log table)
│   │           ├── suggestedDefaults.ts / pythonValidator.ts / retryFetch.ts / logger.ts
│   ├── suno-generator/          # React / Vite frontend
│   │   └── src/
│   │       ├── pages/Home.tsx   # Central page & main state manager (~3,400 lines, 60+ useState)
│   │       ├── components/      # TemplateResult, VariationWorkshop, BatchDashboard, RemixToolbar,
│   │       │                    # RemixChain, ReverseMode, MultiTrackBuilder, TransitionBuilder,
│   │       │                    # SongDnaPanel, AnalyticsDashboard, MoodBoard, GenreGenomeMap, etc.
│   │       └── index.css        # Tailwind + custom design system
│   └── mockup-sandbox/          # Isolated Vite component sandbox
├── lib/
│   ├── api-spec/                # OpenAPI spec (openapi.yaml) & Orval config
│   ├── api-client-react/        # Generated React Query hooks (only covers spec'd endpoints)
│   ├── api-zod/                 # Generated Zod schemas
│   ├── db/                      # Drizzle config (legacy — runtime uses better-sqlite3 directly)
│   └── integrations-openai-ai-* # OpenAI wrapper for server & client
├── data/                        # SQLite storage (`suno-cache.db`)
├── scripts/                     # DietPi / Pi deployment scripts
├── .env.example / DEPLOY.md / PROJECT_CONTEXT.md
└── package.json                 # Monorepo root scripts (pnpm enforced via preinstall hook)
```

---

## 4. Backend API Endpoints (`/api/*`)

Generation & analysis (`routes/suno.ts`):

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/generate-template` | Primary Suno template generation pipeline |
| `POST` | `/api/generate-variations` | Style/lyric variations for a template |
| `GET`  | `/api/playlist-info` | Extract YouTube playlist items |
| `POST` | `/api/batch` | Batch process up to 20 URLs — **streams progress via SSE** |
| `GET`  | `/api/suggest` | Metadata-derived suggested UI settings (uses `AI_MINI_MODEL`) |
| `GET`  | `/api/youtube-preview` | Quick video metadata fetch |
| `POST` | `/api/pre-analyze-structure` | Pre-generation structure analysis |
| `POST` | `/api/analyze-structure` | Lyrics structure breakdown |
| `POST` | `/api/suno/transform` | Transform presets (Acoustic, Cyberpunk, Orchestral, …) |
| `POST` | `/api/multi-track` | Multi-track composition builder |
| `POST` | `/api/transition` | Section transition prompt builder |
| `POST` | `/api/reverse` | Reverse-engineer a Suno prompt into settings |
| `POST` | `/api/mood-to-settings` | Map mood strings to style controls |
| `GET`  | `/api/cache/stats` | Cache performance statistics |

History & sharing (`routes/history.ts`):

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET`  | `/api/history` | List history (search/rating/collection filters) |
| `GET`  | `/api/history/export` | Export history |
| `GET`  | `/api/collections` | List collections |
| `POST` | `/api/history` | Save template |
| `PATCH`| `/api/history/:id/rating` | Update star rating |
| `PATCH`| `/api/history/:id/collection` | Move to collection |
| `DELETE`| `/api/history/bulk` | Bulk delete |
| `DELETE`| `/api/history/:id` / `/api/history` | Delete one / all |
| `POST` | `/api/share` · `GET /api/share/:hash` | Create / resolve share links |

Other: `GET /api/healthz` (health.ts); `GET /api/admin/{health,usage,backup,tags,tags/:category}` (admin.ts, Bearer `ADMIN_KEY` auth when set).

Rate limits (`app.ts`, in-memory per IP): generation endpoints 20 req / 2 min; all other `/api` 120 req / min.

---

## 5. Environment Variables (`.env`)

```ini
# AI Provider (Google Gemini OpenAI endpoint, Groq, or OpenAI)
OPENAI_API_KEY=your_api_key_here
AI_INTEGRATIONS_OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
AI_MODEL=gemini-flash-latest
AI_MINI_MODEL=gemini-flash-lite-latest

# Server
PORT=3000

# Optional
CACHE_DIR=./data                  # SQLite location
GENIUS_API_TOKEN=optional         # Better lyrics fetching
GETSONGBPM_API_KEY=optional       # BPM lookup source
LASTFM_API_KEY=optional           # Genre/mood tags
DISCOGS_TOKEN=optional            # Styles/year
ADMIN_KEY=optional                # Protects /api/admin/*
STATIC_DIR=optional               # Override prod static dir
```

(Check each `lib/*.ts` source for the exact env var name before assuming — some sources no-op silently without their key.)

---

## 6. Key Developer Rules & Caveats

1. **Strict Package Management**: Always `pnpm`. `npm`/`yarn` fail via the `preinstall` hook.
2. **Database Engine**: All persistence is **SQLite** at `./data/suno-cache.db`. Ignore stale PostgreSQL/Drizzle references (`lib/db` is legacy). Do not delete `data/suno-cache.db` without permission.
3. **Monolithic Files**: Backend logic concentrates in `routes/suno.ts` (~2,900 lines); frontend state in `pages/Home.tsx` (~3,400 lines). Perform surgical edits rather than refactors unless explicitly instructed.
4. **API Spec Drift**: `openapi.yaml` covers `/healthz`, `/generate-template`, `/generate-variations`, `/playlist-info`, `/batch`, `/suno/transform`. When touching those, keep the spec in sync and run `pnpm --filter @workspace/api-spec run codegen`. Remaining endpoints (`/suggest`, `/multi-track`, `/reverse`, history/admin routes, etc.) use hand-written `fetch()` + local types in `Home.tsx` — keep both sides matching manually.
5. **Production Bundling**: With `NODE_ENV=production`, `app.ts` serves static assets from `artifacts/suno-generator/dist/public` (esbuild CJS bundle — `import.meta.url` fallbacks matter; preserve them).
6. **Dormant subsystems**: `lib/jobQueue.ts` (table + enqueue/claim functions exist) is wired into nothing — `enqueueJob` has no callers, there's no HTTP route, and no worker runs; don't assume any of it executes. `lib/acoustid.ts` IS wired (fallback in `fetchBaseMetadata`) but no-ops without `ACOUSTID_API_KEY` (unset by default).
7. **Python dependency**: every generation shells out to `validate_chars.py`; the server host needs `python3`.
8. **yt-dlp dependency**: the AcoustID fallback shells out to the `yt-dlp` binary (installed system-wide at `/usr/local/bin/yt-dlp` on the deployment Pi, self-updates via `yt-dlp -U`) to pull an audio sample. `@distube/ytdl-core`'s stream-URL extraction is broken (decipher failure against YouTube's current player) — it's kept only for metadata calls (`getInfo`/`getBasicInfo`), which still work.
9. **DSP analysis dependency**: needs `artifacts/api-server/.venv-audio` (a Python venv — `python3 -m venv .venv-audio && .venv-audio/bin/pip install -r requirements-audio.txt`) and `data/models/{yamnet.tflite,yamnet_class_map.csv}` present, plus `ffmpeg` on PATH. `checkDspAnalysisAvailable()` in `lib/dspAnalysis.ts` no-ops gracefully (falls back to the estimate chain) if any are missing — check `/api/healthz`'s `dspAnalysisAvailable` field or the startup log if audio features aren't upgrading to `dsp-measured`.
