/**
 * Quit handshake for canvas storage (pure; Electron injected by index.ts).
 *
 * First `before-quit` of a quit cycle: if any canvas tab exists (or a tab close is still flushing),
 * hold the quit, flush ALL of them in parallel (bounded), then quit again. The re-entrant pass must not
 * hold. A quit that is cancelled by something else after the hold leaves no stale state: the flag is
 * consumed by the pass it lets through, so a later quit holds again.
 */

import { withTimeout } from "./canvasWriters";

/** Overall cap for the quit flush. */
export const QUIT_FLUSH_MS = 3000;

export interface QuitFlushDeps {
  /** Canvas tabs in any window, or a tab close still flushing. */
  hasWork(): boolean;
  /** Flushes every canvas tab of every window and waits for pending tab-close flushes. */
  flushAll(): Promise<unknown>;
  /** Calls `app.quit()` again. */
  quit(): void;
  timeoutMs?: number;
}

export interface QuitDecision {
  /** First pass of a quit cycle (not the re-entrant one after a hold): run once-per-quit duties here. */
  firstPass: boolean;
}

export interface QuitFlush {
  /** Call from `before-quit`. Calls `event.preventDefault()` when it holds the quit. */
  onBeforeQuit(event: { preventDefault(): void }): QuitDecision;
}

export function createQuitFlush(deps: QuitFlushDeps): QuitFlush {
  const timeoutMs = deps.timeoutMs ?? QUIT_FLUSH_MS;
  let flushing = false;
  let flushed = false;
  return {
    onBeforeQuit(event) {
      if (flushed) {
        flushed = false; // consumed: a later quit may hold again
        return { firstPass: false };
      }
      if (flushing) {
        event.preventDefault(); // a second Cmd+Q during the flush: still held, no second flush
        return { firstPass: false };
      }
      if (!deps.hasWork()) return { firstPass: true };
      flushing = true;
      event.preventDefault();
      let run: Promise<unknown>;
      try {
        run = deps.flushAll();
      } catch {
        run = Promise.resolve();
      }
      void withTimeout(run, timeoutMs).finally(() => {
        flushing = false;
        flushed = true;
        deps.quit();
      });
      return { firstPass: true };
    },
  };
}
