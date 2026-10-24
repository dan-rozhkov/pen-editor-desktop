import * as path from "node:path";
import type { DocFs } from "./docStore";

/** Helpers shared by docStore.ts and canvasStore.ts (same on-disk principles, one implementation). */

/** Temp files (`<name>.<pid>.<random>.tmp`) older than this are swept by `list`. */
export const STALE_TMP_MS = 60 * 60 * 1000;

export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Runs tasks one after another per key (a per-id promise chain). A task runs whether the previous one
 * resolved or rejected; the entry is dropped once the chain is idle.
 */
export function createKeyedChain(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const chains = new Map<string, Promise<unknown>>();
  return function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = chains.get(key) ?? Promise.resolve();
    const run = prev.then(task, task);
    const tail = run.catch(() => undefined);
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  };
}

/** Best effort: removes `.tmp` files older than STALE_TMP_MS (left by an interrupted write). */
export async function sweepStaleTmp(
  io: DocFs,
  rootDir: string,
  files: { name: string; mtimeMs: number }[],
  now: () => number,
  label: string,
): Promise<void> {
  for (const f of files) {
    if (!f.name.endsWith(".tmp") || now() - f.mtimeMs <= STALE_TMP_MS) continue;
    try {
      await io.remove(path.join(rootDir, f.name));
    } catch (err) {
      console.error(`${label}: could not sweep ${f.name}: ${message(err)}`);
    }
  }
}
