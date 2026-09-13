import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // Live specs hit the deployed frontend/backend: opt-in only, via
  // `npm run test:e2e:live`. See e2e/live-prod.spec.ts.
  testIgnore: /[\\/]live-[^\\/]*\.spec\.ts$/,
  timeout: 60_000,
  // Electron tests must not run in parallel against the same built output.
  workers: 1,
});
