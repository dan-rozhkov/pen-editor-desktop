import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Marks a userData dir this module created (so teardown deletes only that). */
export const OWNED_USER_DATA_ENV = "PEN_E2E_OWNED_USER_DATA_DIR";

/**
 * Gives every Electron launch of THIS Playwright run (they all spread
 * process.env into their launch env) a throwaway userData dir, via
 * PEN_DESKTOP_USER_DATA_DIR (honoured by src/main/index.ts before app.ready).
 * The dir is fresh per run and shared by that run's launches — enough to
 * isolate e2e from a developer's saved settings (cursor-settings.json). A dir
 * the developer set explicitly is left alone. Deleted by globalTeardown.ts.
 */
export function isolateUserData(): void {
  // No e2e launch may fetch the ad-block filter lists (hermetic, no network): see "Ad and tracker blocking".
  process.env.PEN_DESKTOP_NO_ADBLOCK = "1";
  if (process.env.PEN_DESKTOP_USER_DATA_DIR) return;
  const dir = mkdtempSync(path.join(tmpdir(), "pen-desktop-e2e-"));
  process.env.PEN_DESKTOP_USER_DATA_DIR = dir;
  process.env[OWNED_USER_DATA_ENV] = dir;
}
