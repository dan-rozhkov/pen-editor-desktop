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
import { PAGE_DRIVING_COMMANDS } from "./browserCommands";

export const AGENT_ACTIVITY_IDLE_MS = 4000;

/**
 * How long a browser tab the agent drove stays rendering in the background
 * after its last page-driving command. It covers the LLM thinking between
 * steps; the 4 s icon hold is too short for that. A tab that is not shown
 * would otherwise freeze (rAF stops, timers run at 1/s, captures are empty).
 */
export const AGENT_AWAKE_HOLD_MS = 60_000;

/** Notification shown when the window is minimized while an agent tab is awake. */
// Shown during the whole awake hold, also after the agent finished, so it must not claim the agent is running.
export const MINIMIZED_AGENT_NOTICE_TITLE = "The agent's browser tab is paused";
export const MINIMIZED_AGENT_NOTICE_BODY =
  "Pages in the agent's browser tab stop while the window is minimized. If the agent is still working, open the window to let it continue.";

/** Chromium switch: a window covered by another app's window keeps rendering. */
export const KEEP_RENDERING_WHEN_OCCLUDED_SWITCH = "disable-backgrounding-occluded-windows";

const PAGE_COMMANDS = PAGE_DRIVING_COMMANDS;

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

export interface TabAgentActivityOptions extends Omit<AgentActivityOptions, "onChange"> {
  onChange: (tabId: number, working: boolean) => void;
}

export interface TabAgentActivity {
  begin(tabId: number): void;
  end(tabId: number): void;
  /** begin + end: shows the icon on a tab the agent just landed on (new/switch/popup). */
  pulse(tabId: number): void;
  dispose(): void;
}

/**
 * One activity tracker per browser tab, each with its own in-flight count and
 * idle hold, so parallel runs (isolated sessions) light up their own tabs and
 * one finishing never clears another's icon.
 */
export function createTabAgentActivity(opts: TabAgentActivityOptions): TabAgentActivity {
  const perTab = new Map<number, AgentActivity>();
  let disposed = false;
  const get = (tabId: number): AgentActivity => {
    let a = perTab.get(tabId);
    if (!a) {
      const created: AgentActivity = createAgentActivity({
        ...opts,
        onChange: (working) => {
          opts.onChange(tabId, working);
          if (!working) {
            created.dispose();
            if (perTab.get(tabId) === created) perTab.delete(tabId);
          }
        },
      });
      perTab.set(tabId, created);
      a = created;
    }
    return a;
  };
  return {
    begin: (id) => {
      if (!disposed) get(id).begin();
    },
    end: (id) => {
      if (!disposed) get(id).end();
    },
    pulse: (id) => {
      if (disposed) return;
      const a = get(id);
      a.begin();
      a.end();
    },
    dispose: () => {
      disposed = true;
      for (const a of perTab.values()) a.dispose();
      perTab.clear();
    },
  };
}
