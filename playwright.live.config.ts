import { defineConfig } from "@playwright/test";
import { isolateUserData } from "./e2e/userDataIsolation";

// Fresh userData dir per run, deleted afterwards (e2e/userDataIsolation.ts).
isolateUserData();

// Opt-in config for the live specs the default run ignores: they drive the
// deployed frontend/backend over the network. See e2e/live-prod.spec.ts.
export default defineConfig({
  testDir: "e2e",
  testMatch: /[\\/]live-[^\\/]*\.spec\.ts$/,
  timeout: 300_000,
  workers: 1,
  globalTeardown: "./e2e/globalTeardown.ts",
});
