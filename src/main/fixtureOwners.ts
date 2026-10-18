// Ownership of the SHARED browser's fixture. One BrowserController per window is
// used by every editor tab and by the agent panel (agent layout), and it holds
// at most one active fixture. Main remembers WHO applied it (a webContents id)
// and its token, the way journalOwners.ts does for the checkpoint journal, so a
// reload, crash or close of one owner releases only a fixture that owner applied
// and never another tab's (or the panel's) run. Electron-free so it is unit-tested.

export class FixtureOwners {
  private current: { owner: number; token: string | undefined } | null = null;

  /**
   * An `applyFixture` starts. The controller releases the previous fixture
   * first, so nobody owns one until this apply succeeds.
   */
  beginApply(): void {
    this.current = null;
  }

  /** The apply ended with `result` (the controller's FixtureApplyResult). Only a success is owned. */
  finishApply(sender: number, result: unknown): void {
    const r = (result ?? {}) as { ok?: unknown; fixtureToken?: unknown };
    this.current =
      r.ok === true ? { owner: sender, token: typeof r.fixtureToken === "string" ? r.fixtureToken : undefined } : null;
  }

  /** An explicit `releaseFixture` ran: no token releases whatever is active, a token only that fixture. */
  released(token?: string): void {
    if (token === undefined || this.current?.token === token) this.current = null;
  }

  /**
   * The owner reloaded, crashed or closed. Returns what to release: `null` when
   * it owns nothing, else `{ token }` (a token-less fixture is released by
   * passing `undefined`). The ownership is dropped.
   */
  takeOwnedBy(sender: number): { token: string | undefined } | null {
    const cur = this.current;
    if (!cur || cur.owner !== sender) return null;
    this.current = null;
    return { token: cur.token };
  }
}
