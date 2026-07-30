import { defineConfig } from "vitest/config";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// cache.ts opens ./data/suno-cache.db by default — point tests at a throwaway SQLite file
// instead, so running the suite never touches real production history/cache data.
const testCacheDir = mkdtempSync(join(tmpdir(), "track-template-vitest-"));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // suno.ts eagerly constructs an OpenAI client at import time — a dummy key lets pure-function
    // tests import the module without a real .env; no network call happens unless a test invokes it.
    env: {
      OPENAI_API_KEY: "test-key-for-unit-tests-only",
      AI_INTEGRATIONS_OPENAI_BASE_URL: "https://example.invalid/v1",
      AI_INTEGRATIONS_OPENAI_API_KEY: "test-key-for-unit-tests-only",
      CACHE_DIR: testCacheDir,
    },
  },
});
