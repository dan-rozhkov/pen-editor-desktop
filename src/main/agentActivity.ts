/**
 * Tracks whether the AI agent is currently driving the built-in browser, for
 * the tab strip's agent-cursor icon. Pure and Electron-free: timers are
 * injected so tests run on a fake clock.
 *
 * It counts in-flight `browser:command`s. The agent is "working" from the
 * first `begin()` until `idleMs` after the count returns to 0 — the hold
 * keeps the icon steady in the gaps between browse steps while the LLM
 * thinks, instead of flickering on every command.
 */
export const AGENT_ACTIVITY_IDLE_MS = 4000;

const PAGE_COMMANDS = new Set([
  "open",
  "act",
  "findImages",
  "snapshot",
  "perform",
  "read",
  "screenshot",
  "tabs",
  "capture",
  "applyFixture",
  "fillLogin",
]);

/**
 * Whether a `browser:command` drives a page and so counts as agent activity.
 * Journal/checkpoint/fixture-release bookkeeping, a read-only `tabs` listing
 * and unknown commands do not.
 */
export function isAgentPageCommand(command: string, args: unknown): boolean {
  if (!PAGE_COMMANDS.has(command)) return false;
  if (command === "tabs") {
    const action = typeof args === "object" && args !== null ? (args as { action?: unknown }).action : undefined;
    return action !== "list";
  }
  return true;
}

export interface AgentActivityOptions {
  onChange: (working: boolean) => void;
  idleMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface AgentActivity {
  begin(): void;
  end(): void;
  dispose(): void;
}

export function createAgentActivity(opts: AgentActivityOptions): AgentActivity {
  const idleMs = opts.idleMs ?? AGENT_ACTIVITY_IDLE_MS;
  const setTimer = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let inFlight = 0;
  let working = false;
  let timer: unknown = null;
  // An in-flight command's `finally` can run after the window closed.
  let disposed = false;

  const cancelTimer = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };
  const set = (next: boolean) => {
    if (working === next) return;
    working = next;
    opts.onChange(next);
  };

  return {
    begin() {
      if (disposed) return;
      inFlight++;
      cancelTimer();
      set(true);
    },
    end() {
      if (disposed) return;
      if (inFlight > 0) inFlight--;
      if (inFlight > 0 || !working) return;
      cancelTimer();
      timer = setTimer(() => {
        timer = null;
        set(false);
      }, idleMs);
    },
    dispose() {
      disposed = true;
      cancelTimer();
    },
  };
}
