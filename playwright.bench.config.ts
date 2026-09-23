import { defineConfig } from "@playwright/test";

// Opt-in config for the jev-vs-nojev browse benchmark: it launches the real
// Electron shell against the deployed frontend, drives an actual AI chat
// turn (real tokens), and can take up to ~12 minutes per run. See
// e2e/bench-browse.spec.ts. Not part of the default `npm run test:e2e` run
// (playwright.config.ts's testIgnore excludes bench-*.spec.ts) and not part
// of the live gate (playwright.live.config.ts only matches live-*.spec.ts).
export default defineConfig({
  testDir: "e2e",
  testMatch: /[\\/]bench-[^\\/]*\.spec\.ts$/,
  timeout: 900_000, // 15 minutes per test — comfortably above the spec's own 12-minute per-run cap.
  workers: 1,
  // A single failing/slow run should not burn tokens on a retry.
  retries: 0,
});
