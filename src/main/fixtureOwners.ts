// Ownership of the SHARED browser's fixture. One BrowserController per window is
// used by every editor tab and by the agent panel (agent layout), and it holds
// at most one active fixture. Main remembers WHO applied it (a webContents id)
// and its token, the way journalOwners.ts does for the checkpoint journal, so a
// reload, crash or close of one owner releases only a fixture that owner applied
// and never another tab's (or the panel's) run. Electron-free so it is unit-tested.
//
// The owner is recorded when the apply STARTS (pending), not when it ends: an
// owner that reloads, crashes or closes during the apply marks the in-flight
// fixture for release, and `finishApply` hands back what to release.

interface Current {
  ticket: number;
  /** When the apply started (ms). Kept across finishApply. */
  startedAt: number;
  owner: number;
  token: string | undefined;
  pending: boolean;
  /** The owner went away while the apply was in flight. */
  doomed: boolean;
}

export interface FixtureRelease {
  token: string | undefined;
}

export class FixtureOwners {
  private current: Current | null = null;
  private nextTicket = 1;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * An `applyFixture` by `sender` starts. The controller releases the previous
   * fixture first. Returns the ticket to pass to `finishApply`.
   */
  beginApply(sender: number): number {
    const ticket = this.nextTicket++;
    this.current = { ticket, startedAt: this.now(), owner: sender, token: undefined, pending: true, doomed: false };
    return ticket;
  }

  /**
   * The apply ended with `result` (the controller's FixtureApplyResult).
   * `senderAlive` is whether the sender is still a live browser owner. Returns
   * what the caller must release now (a success whose owner is gone or went away
   * mid-apply), else `null`. Only a success is owned.
   */
  finishApply(ticket: number, sender: number, result: unknown, senderAlive = true): FixtureRelease | null {
    const cur = this.current;
    if (!cur || cur.ticket !== ticket) return null; // superseded by a later apply
    const r = (result ?? {}) as { ok?: unknown; fixtureToken?: unknown };
    if (r.ok !== true) {
      this.current = null;
      return null;
    }
    const token = typeof r.fixtureToken === "string" ? r.fixtureToken : undefined;
    if (cur.doomed || !senderAlive) {
      this.current = null;
      return { token };
    }
    this.current = { ticket, startedAt: cur.startedAt, owner: sender, token, pending: false, doomed: false };
    return null;
  }

  /** An explicit `releaseFixture` ran: no token releases whatever is active, a token only that fixture. */
  released(token?: string): void {
    if (this.current?.pending) return;
    if (token === undefined || this.current?.token === token) this.current = null;
  }

  /**
   * The owner reloaded, crashed or closed. Returns what to release: `null` when
   * it owns nothing (or its apply is still in flight: that one is marked and
   * `finishApply` returns the release), else `{ token }` (a token-less fixture
   * is released by passing `undefined`). The ownership is dropped.
   */
  takeOwnedBy(sender: number): FixtureRelease | null {
    const cur = this.current;
    if (!cur || cur.owner !== sender) return null;
    if (cur.pending) {
      cur.doomed = true;
      return null;
    }
    this.current = null;
    return { token: cur.token };
  }

  /** A fixture is applied, being applied, or its apply was marked for release. */
  isActive(): boolean {
    return this.current !== null;
  }

  /** When the current fixture started to apply (ms), or null when none is active. */
  activeSince(): number | null {
    return this.current?.startedAt ?? null;
  }
}
