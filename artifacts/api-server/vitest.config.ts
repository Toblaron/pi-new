import { defineConfig } from "vitest/config";

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
    },
  },
});
