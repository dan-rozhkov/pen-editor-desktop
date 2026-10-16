// Ownership of the checkpoint journal. One BrowserController per window is
// shared by all its editor tabs, and the controller's journal commands act on
// "the" journal. Main therefore remembers which editor tab (webContents id)
// started it, refuses every other tab, and ends the journal when another tab
// drives the browser (its steps would otherwise be recorded into it).
// Electron-free so it is unit-tested.

/** The slice of `BrowserController` this module drives. */
export interface JournalController {
  startJournal(opts?: { origins?: string[] }): string;
  stopJournal(token?: string): boolean;
  captureCheckpoint(token?: string): Promise<unknown>;
}

/** A journal older than this may be taken over (browse subagent deadline is 15 min). */
export const JOURNAL_STALE_MS = 20 * 60 * 1000;

/** Commands that do not change the page, so they are never recorded. */
const READ_ONLY_COMMANDS = new Set([
  "snapshot",
  "read",
  "screenshot",
  "findImages",
  "capture",
  "captureCheckpoint",
  "stopJournal",
  "startJournal",
]);

function isPageChanging(command: string, args: unknown): boolean {
  if (READ_ONLY_COMMANDS.has(command)) return false;
  if (command === "tabs") {
    const action = typeof args === "object" && args !== null ? (args as { action?: unknown }).action : undefined;
    return action !== "list";
  }
  return true;
}

export class JournalOwners {
  // At most one journal is live: a second start replaces it in the controller.
  private current: { token: string; owner: number; startedAt: number } | null = null;

  constructor(
    private readonly controller: JournalController,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * `isLive(id)`: the owner is still a registered editor tab. A dead owner's
   * journal may be replaced, and so may one older than JOURNAL_STALE_MS (a
   * missed stop must not lock the other tabs out while the owner tab lives).
   */
  start(sender: number, isLive: (id: number) => boolean, origins?: string[]): string | { error: string } {
    const cur = this.current;
    if (cur && cur.owner !== sender && isLive(cur.owner)) {
      if (this.now() - cur.startedAt <= JOURNAL_STALE_MS) {
        return { error: "another editor tab is recording a checkpoint" };
      }
      this.controller.stopJournal(cur.token);
      this.current = null;
    }
    const token = this.controller.startJournal(origins ? { origins } : undefined);
    this.current = { token, owner: sender, startedAt: this.now() };
    return token;
  }

  /**
   * Call before dispatching any `browser:command`. A page-changing command from
   * a tab that does not own the running journal would be recorded into it, so
   * the foreign journal is stopped: its owner's capture then fails cleanly
   * instead of returning a checkpoint with another tab's steps.
   */
  beforeCommand(sender: number, command: string, args: unknown, isLive: (id: number) => boolean): void {
    const cur = this.current;
    if (!cur || cur.owner === sender || !isLive(cur.owner)) return;
    if (!isPageChanging(command, args)) return;
    this.current = null;
    this.controller.stopJournal(cur.token);
  }

  stop(sender: number, token: string | undefined): boolean {
    if (token === undefined || !this.owns(sender, token)) return false;
    this.current = null;
    return this.controller.stopJournal(token);
  }

  async capture(sender: number, token: string | undefined): Promise<unknown> {
    if (token === undefined || !this.owns(sender, token)) {
      return { ok: false, error: "no checkpoint journal owned by this editor tab" };
    }
    return this.controller.captureCheckpoint(token);
  }

  /** Reload/crash/close of an editor tab: stop only the journal it owns. */
  stopOwnedBy(sender: number): void {
    const cur = this.current;
    if (!cur || cur.owner !== sender) return;
    this.current = null;
    this.controller.stopJournal(cur.token);
  }

  private owns(sender: number, token: string): boolean {
    return this.current?.token === token && this.current.owner === sender;
  }
}
