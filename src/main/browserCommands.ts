// The one list of `browser:command` commands. Everything that needs "which
// commands exist" derives from it: the session planner (browserSessions.ts),
// the agent-activity icon (agentActivity.ts) and the contract test that pins
// the preload and the dispatch switch in window.ts to it. `closeSession` is a
// session-management command handled before dispatch, not in this list.

export const BROWSER_COMMANDS = [
  "open",
  "act",
  "findImages",
  "snapshot",
  "perform",
  "assert",
  "read",
  "screenshot",
  "tabs",
  "capture",
  "applyFixture",
  "releaseFixture",
  "clearActEmulation",
  "fillLogin",
  "startJournal",
  "stopJournal",
  "captureCheckpoint",
  "releaseApp",
] as const;

export type BrowserCommandName = (typeof BROWSER_COMMANDS)[number];

/** Commands that drive a page (agent activity); journal/checkpoint/release are bookkeeping. */
export const PAGE_DRIVING_COMMANDS: ReadonlySet<string> = new Set<BrowserCommandName>([
  "open",
  "act",
  "findImages",
  "snapshot",
  "perform",
  "assert",
  "read",
  "screenshot",
  "tabs",
  "capture",
  "applyFixture",
  "fillLogin",
]);
