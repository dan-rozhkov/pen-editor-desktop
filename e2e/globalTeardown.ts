import { rmSync } from "node:fs";
import { OWNED_USER_DATA_ENV } from "./userDataIsolation";

// Deletes the temp userData dir userDataIsolation.ts created for this run.
export default function globalTeardown(): void {
  const dir = process.env[OWNED_USER_DATA_ENV];
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort — it is a temp dir
  }
}
