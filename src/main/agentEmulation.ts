// Bookkeeping for the Browser tools menu's Viewport record (pure; window.ts
// feeds it, tests feed it fixtures).
//
// A fixture's `emulate` and the user's Viewport menu both drive Emulation.* on
// the same tab. Releasing an emulating fixture clears the device-metrics and
// user-agent overrides, including a viewport the user picked, so the menu must
// forget its record of exactly those tabs. This tracker learns WHICH tabs by
// watching the CDP calls the agent's fixture makes on them (only inside an
// apply window), and WHICH fixture by the controller's `fixtureToken`.
//
// A colour-scheme / locale / timezone-only emulate never sets metrics or a UA,
// so it is never recorded and never touches the menu.

/** The overrides that the menu's Viewport also owns. */
const VIEWPORT_METHODS = new Set(["Emulation.setDeviceMetricsOverride", "Emulation.setUserAgentOverride"]);

export interface AgentEmulationTracker {
  /**
   * An `applyFixture` starts. The controller releases the previous fixture
   * first, so the tabs that one overrode are returned: reset their records.
   */
  beginApply(): number[];
  /** A CDP call on `tab`. Counts only inside an apply window and only for viewport-owning overrides. */
  note(tab: number, method: string): void;
  /**
   * The apply ended with `result` (the controller's FixtureApplyResult). On
   * success the overridden tabs are remembered under the result's token. On a
   * failure the controller already cleaned up what the apply set, which wiped
   * the user's viewport on those tabs too: they are returned for a reset.
   */
  finishApply(result: unknown): number[];
  /**
   * A release. `token` is the one the caller passed to the controller (absent =
   * release whatever is active). Returns the tabs to reset: empty for a stale
   * token (the controller ignores it too) or a fixture that overrode nothing.
   */
  release(token?: string): number[];
}

export function createAgentEmulationTracker(): AgentEmulationTracker {
  let applying = false;
  let pending = new Set<number>();
  let active: { token: string; tabs: Set<number> } | null = null;
  return {
    beginApply() {
      const previous = active ? [...active.tabs] : [];
      active = null;
      applying = true;
      pending = new Set();
      return previous;
    },
    note(tab, method) {
      if (applying && VIEWPORT_METHODS.has(method)) pending.add(tab);
    },
    finishApply(result) {
      applying = false;
      const tabs = pending;
      pending = new Set();
      const r = (result ?? {}) as { ok?: unknown; fixtureToken?: unknown };
      if (r.ok === true && typeof r.fixtureToken === "string") {
        if (tabs.size > 0) active = { token: r.fixtureToken, tabs };
        return [];
      }
      return [...tabs];
    },
    release(token) {
      if (!active) return [];
      if (token !== undefined && token !== active.token) return [];
      const tabs = [...active.tabs];
      active = null;
      return tabs;
    },
  };
}
