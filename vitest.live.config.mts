import { defineConfig } from "vitest/config";

// Tests that call real external services. They run only when the matching credential is present
// in the environment and are never part of `npm test` / CI's deterministic suite.
export default defineConfig({
  test: { include: ["src/test-live/**/*.live.test.ts"], testTimeout: 60_000 },
});
