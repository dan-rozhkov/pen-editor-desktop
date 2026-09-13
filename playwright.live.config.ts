import { defineConfig } from "@playwright/test";

// Opt-in config for the live specs the default run ignores: they drive the
// deployed frontend/backend over the network. See e2e/live-prod.spec.ts.
export default defineConfig({
  testDir: "e2e",
  testMatch: /live-.*\.spec\.ts/,
  timeout: 300_000,
  workers: 1,
});
