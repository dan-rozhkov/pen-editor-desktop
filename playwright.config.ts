import { defineConfig } from "@playwright/test";
import { isolateUserData } from "./e2e/userDataIsolation";

// Fresh userData dir per run (shared by its launches), deleted afterwards:
// see e2e/userDataIsolation.ts.
isolateUserData();

export default defineConfig({
  testDir: "e2e",
  // Live specs hit the deployed frontend/backend: opt-in only, via
  // `npm run test:e2e:live`. See e2e/live-prod.spec.ts. Bench specs drive a
  // real AI chat turn against the deployed app (real tokens, up to 15 min):
  // opt-in only, via `npm run test:e2e:bench`. See e2e/bench-browse.spec.ts
  // and playwright.bench.config.ts. The bench fixture's own sanity test
  // (e2e/browser-shop-fixture.spec.ts) is deliberately NOT bench-*.spec.ts,
  // so it stays in this default run.
  testIgnore: /[\\/](live|bench)-[^\\/]*\.spec\.ts$/,
  timeout: 60_000,
  // Electron tests must not run in parallel against the same built output.
  workers: 1,
  globalTeardown: "./e2e/globalTeardown.ts",
});
