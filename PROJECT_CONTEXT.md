# Project Context For Coding Agents

This file is a compact map of the repo so an AI coding agent can read this first instead of scanning the whole codebase.

## What This Project Is

Track -> Template is a TypeScript pnpm workspace that converts YouTube song links into structured Suno.ai prompt templates. It has:

- A React/Vite frontend in `artifacts/suno-generator`
- An Express 5 API server in `artifacts/api-server`
- Shared generated API packages in `lib/api-*`
- OpenAI integration wrappers in `lib/integrations-openai-ai-server` and `lib/integrations-openai-ai-react`
- SQLite cache/history files under `data/`
- Raspberry Pi/DietPi deployment scripts and docs

The product flow is: user enters a YouTube URL, frontend calls backend, backend fetches metadata/lyrics/audio hints, calls OpenAI, then returns a Suno template with style prompt, title, lyrics/metatags, negative prompt, tags, and extra analysis.

## Workspace Layout

```text
.
|-- artifacts/
|   |-- api-server/          Express API server, production bundle via esbuild
|   |-- suno-generator/      Main React + Vite + Tailwind app
|   `-- mockup-sandbox/      Separate Vite sandbox with shadcn-style UI components
|-- lib/
|   |-- api-spec/            OpenAPI spec and Orval config
|   |-- api-client-react/    Generated React Query client/hooks
|   |-- api-zod/             Generated Zod request/response schemas
|   |-- db/                  Drizzle/Postgres schema, currently not central to API runtime
|   |-- integrations-openai-ai-server/
|   |-- integrations-openai-ai-react/
|   `-- integrations/openai_ai_integrations/  Older/alternate integration copy
|-- scripts/                 Pi setup and small TS utility package
|-- attached_assets/         Images/text prompt references used by frontend/assets
|-- data/                    SQLite cache/history DB (`suno-cache.db`)
|-- DEPLOY.md                Pi/DietPi deployment guide
|-- replit.md                Older generated project overview; partly stale
|-- package.json             Root scripts
`-- pnpm-workspace.yaml      Workspace and catalog dependency versions
```

## Tooling And Commands

Use pnpm. Root `package.json` enforces pnpm in `preinstall`.

Common commands:

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm run build:prod
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/suno-generator run dev
pnpm --filter @workspace/api-spec run codegen
```

Important notes:

- Root typecheck uses TypeScript project references. Prefer `pnpm run typecheck` from repo root.
- Production build is `BASE_PATH=/ PORT=3000 pnpm --filter @workspace/suno-generator run build && pnpm --filter @workspace/api-server run build`.
- Production start is `NODE_ENV=production node --env-file=.env artifacts/api-server/dist/index.cjs`.
- Frontend dev server defaults to `PORT` or 3000 and binds `0.0.0.0`.

## Main Backend Files

- `artifacts/api-server/src/index.ts`: starts Express on `PORT`.
- `artifacts/api-server/src/app.ts`: CORS, JSON parsing, rate limiters, `/api` router, static frontend serving in production.
- `artifacts/api-server/src/routes/index.ts`: mounts health, suno, and history routers.
- `artifacts/api-server/src/routes/suno.ts`: core generation logic and most API endpoints. This is large and includes YouTube metadata fetching, lyrics lookup, MusicBrainz parsing, audio feature detection, OpenAI prompting, variation generation, transforms, batch, reverse mode, multi-track, and transitions.
- `artifacts/api-server/src/routes/history.ts`: server-side history, rating, and share-link endpoints.
- `artifacts/api-server/src/lib/cache.ts`: SQLite cache in `CACHE_DIR` or `./data`, including deterministic cache keys and TTLs.
- `artifacts/api-server/src/lib/historyStore.ts`: SQLite tables for `template_history` and `shared_templates`, reusing cache DB.
- `artifacts/api-server/src/lib/audioFeatures.ts`: audio feature detection helpers.
- `artifacts/api-server/src/lib/lyricsStructure.ts`: lyrics section analysis.
- `artifacts/api-server/src/lib/suggestedDefaults.ts`: derives suggested UI defaults from metadata/features.
- `artifacts/api-server/src/lib/fingerprint.ts`: song DNA/fingerprint data.
- `artifacts/api-server/src/lib/pythonValidator.ts` and `src/validate_chars.py`: optional validation helpers.

Backend dependencies include Express 5, `@distube/ytdl-core`, `node-html-parser`, `better-sqlite3`, `essentia.js`, `audio-decode`, generated Zod schemas, and the OpenAI server integration.

## Backend API Surface

All routes are mounted under `/api`.

Health/history/share:

- `GET /healthz`
- `GET /history?limit=50`
- `POST /history`
- `PATCH /history/:id/rating`
- `DELETE /history/:id`
- `DELETE /history`
- `POST /share`
- `GET /share/:hash`

Suno and analysis:

- `POST /generate-template`
- `POST /generate-variations`
- `GET /playlist-info`
- `POST /batch`
- `GET /suggest`
- `GET /youtube-preview`
- `POST /pre-analyze-structure`
- `POST /analyze-structure`
- `POST /suno/transform`
- `GET /cache/stats`
- `POST /multi-track`
- `POST /transition`
- `POST /reverse`
- `POST /mood-to-settings`

Rate limiting in `app.ts`:

- Heavy endpoints: 20 requests per 2 minutes per IP for generation-like routes.
- Other `/api` routes: 120 requests per minute per IP.

## Main Frontend Files

- `artifacts/suno-generator/src/App.tsx`: React Query provider, Wouter route setup, single main route `/`.
- `artifacts/suno-generator/src/pages/Home.tsx`: main page and most app state. Handles URL input, options, generation, history, share links, variations, rating, server sync, suggested defaults, batch mode, and composition of feature panels.
- `artifacts/suno-generator/src/components/TemplateResult.tsx`: displays generated Suno template and copy/regenerate controls.
- `artifacts/suno-generator/src/components/VariationWorkshop.tsx`: compares/merges generated variations.
- `artifacts/suno-generator/src/components/BatchDashboard.tsx`: batch/playlist generation results.
- `artifacts/suno-generator/src/components/LyricsStructurePanel.tsx`: editable/confirmable lyrics sections.
- `artifacts/suno-generator/src/components/RemixToolbar.tsx`: transform preset UI. Presets should stay in sync with backend `TRANSFORM_PRESETS` in `suno.ts`.
- `artifacts/suno-generator/src/components/RemixChain.tsx`: remix/version breadcrumbs.
- `artifacts/suno-generator/src/components/TemplateVersionControl.tsx`: local template restore points.
- `artifacts/suno-generator/src/components/ReverseMode.tsx`: reverse-engineer existing Suno prompt into settings.
- `artifacts/suno-generator/src/components/GenreGenomeMap.tsx`, `MoodBoard.tsx`, `AnalyticsDashboard.tsx`, `MultiTrackBuilder.tsx`, `TransitionBuilder.tsx`: feature panels calling backend endpoints directly or through generated hooks.
- `artifacts/suno-generator/src/lib/promptScorer.ts`: prompt quality scoring.
- `artifacts/suno-generator/src/hooks/usePWA.ts`: PWA install/offline support.
- `artifacts/suno-generator/src/index.css`: Tailwind and global styling.

The frontend imports generated hooks/types from `@workspace/api-client-react`, but some newer endpoints appear to use direct `fetch` calls from components/Home.

## Generated API Packages

- Source of truth: `lib/api-spec/openapi.yaml`
- Orval config: `lib/api-spec/orval.config.ts`
- Generated Zod package: `lib/api-zod/src/generated/*`
- Generated React Query client: `lib/api-client-react/src/generated/*`

If API request/response shapes change, update `openapi.yaml`, run codegen, then adjust backend/frontend. Note that `openapi.yaml` may lag behind newer backend endpoints, so verify route files before assuming the spec is complete.

## Data And Persistence

There are two persistence stories:

- `lib/db` defines Drizzle/Postgres schema and requires `DATABASE_URL`, but the current API server code primarily uses SQLite for cache/history.
- Runtime cache/history/share data lives in a SQLite DB from `artifacts/api-server/src/lib/cache.ts`, defaulting to `./data/suno-cache.db`.

Tables created at runtime:

- `cache`
- `template_history`
- `shared_templates`

Do not delete `data/suno-cache.db` unless the user explicitly wants cache/history reset.

## Environment Variables

Common vars seen in code/docs:

- `PORT`: server/frontend port, commonly 3000.
- `NODE_ENV`: production enables Express static frontend serving.
- `OPENAI_API_KEY`: mentioned in deployment docs.
- `AI_MODEL`: defaults to `gpt-5.2`.
- `AI_MINI_MODEL`: defaults to `gpt-4.1-mini`.
- `AI_INTEGRATIONS_OPENAI_BASE_URL` and `AI_INTEGRATIONS_OPENAI_API_KEY`: used by Replit/OpenAI integration wrapper.
- `GENIUS_API_TOKEN`: optional, improves Genius lyrics fetching.
- `GETSONGBPM_API_KEY`: optional per deploy docs.
- `CACHE_DIR`: overrides SQLite data directory.
- `STATIC_DIR`: overrides static frontend directory in production.
- `BASE_PATH`: Vite base path/PWA scope.
- `ADMIN_KEY`: protects `/api/cache/stats` when set.
- `DATABASE_URL`: required only by `lib/db` when imported.

## Deployment

`DEPLOY.md` targets Raspberry Pi 5/DietPi:

1. Install Node, pnpm, PM2, Nginx.
2. `pnpm install`
3. Create `.env`
4. `pnpm run build:prod`
5. Start `artifacts/api-server/dist/index.cjs` with PM2.
6. Put Nginx in front of port 3000.

There are also shell scripts:

- `setup-pi.sh`
- `update-pi.sh`
- `scripts/setup-dietpi.sh`
- `scripts/suno-generator.service`
- `scripts/post-merge.sh`

Review scripts before running on Windows or outside a Pi.

## Known Caveats

- `replit.md` is useful but stale: it lists fewer endpoints and says Postgres is the database, while runtime cache/history currently use SQLite.
- Some files contain mojibake/encoding artifacts in comments and text, likely from earlier UTF-8 display issues. Avoid broad formatting churn unless fixing text intentionally.
- `artifacts/api-server/src/routes/suno.ts` is very large. Prefer surgical edits and search for the specific route/helper before changing behavior.
- `Home.tsx` is also very large and state-heavy. Prefer extracting only when it clearly reduces risk; otherwise keep changes localized.
- There are duplicated UI component sets under `artifacts/suno-generator/src/components/ui` and `artifacts/mockup-sandbox/src/components/ui`.
- `lib/integrations/openai_ai_integrations` appears to duplicate or preserve an older integration structure. Prefer the packages named `integrations-openai-ai-*` unless existing imports say otherwise.
- `attached_assets/` contains images and prompt/reference text used by the frontend. Do not remove assets without checking imports.

## Suggested First Reads By Task

Backend generation bug:

1. `artifacts/api-server/src/routes/suno.ts`
2. `artifacts/api-server/src/lib/cache.ts`
3. `artifacts/api-server/src/lib/lyricsStructure.ts`
4. `lib/api-spec/openapi.yaml` if request/response types change

Frontend generation UI:

1. `artifacts/suno-generator/src/pages/Home.tsx`
2. `artifacts/suno-generator/src/components/TemplateResult.tsx`
3. Relevant feature component in `artifacts/suno-generator/src/components/`
4. `artifacts/suno-generator/src/index.css`

Generated client/type issue:

1. `lib/api-spec/openapi.yaml`
2. `lib/api-spec/orval.config.ts`
3. `lib/api-client-react/src/generated/*`
4. `lib/api-zod/src/generated/*`

Pi deployment issue:

1. `DEPLOY.md`
2. `setup-pi.sh`
3. `update-pi.sh`
4. `scripts/suno-generator.service`
5. `artifacts/api-server/src/app.ts`

## Quick Mental Model

The frontend is mostly one rich single-page workflow. The backend is one Express process serving both API and static frontend in production. The core generation code fetches source-song data from YouTube and public music/lyrics services, enriches it, caches stages in SQLite, then calls OpenAI to produce a structured Suno template. Most feature additions either touch `Home.tsx` plus a focused component, or one endpoint/helper in `suno.ts`.
