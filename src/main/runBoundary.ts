// Detects the start of an agent run so per-tab diagnostics buffers (console
// errors, failed requests) from BEFORE the run are not reported inside it.
//
// The shell has no explicit "run started" message. `applyFixture` is an exact
// signal (window.ts flushes on it directly). For a run without a fixture the
// best available signal is time: the first command of a scope, or the first
// command after `gapMs` without any command, begins a new run. Gaps between
// the steps of one run are model think time (seconds to tens of seconds), so a
// gap of minutes means the previous run is over. A shorter gap would flush
// failures that happened while the model was thinking.

export const RUN_GAP_MS = 5 * 60_000;

export interface RunBoundary {
  /** A command starts in `scope`. True when it begins a new run. */
  commandStart(scope: string, now?: number): boolean;
  /** A command ended in `scope` (restarts that scope's idle clock). */
  commandEnd(scope: string, now?: number): void;
  /** Forget a scope (isolated session closed). */
  forget(scope: string): void;
}

export function createRunBoundary(gapMs: number = RUN_GAP_MS): RunBoundary {
  const last = new Map<string, number>();
  const inFlight = new Map<string, number>();
  return {
    commandStart(scope, now = Date.now()) {
      const prev = last.get(scope);
      const running = (inFlight.get(scope) ?? 0) > 0;
      inFlight.set(scope, (inFlight.get(scope) ?? 0) + 1);
      last.set(scope, now);
      return !running && (prev === undefined || now - prev >= gapMs);
    },
    commandEnd(scope, now = Date.now()) {
      const n = (inFlight.get(scope) ?? 1) - 1;
      if (n <= 0) inFlight.delete(scope);
      else inFlight.set(scope, n);
      last.set(scope, now);
    },
    forget(scope) {
      last.delete(scope);
      inFlight.delete(scope);
    },
  };
}
