import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  // Electron tests must not run in parallel against the same built output.
  workers: 1,
});
