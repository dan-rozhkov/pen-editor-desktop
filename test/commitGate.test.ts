import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BLANK_DOCUMENT_URL, PLACEHOLDER_START_TIMEOUT_MS, createCommitGate, type CommitGateDeps } from "../src/main/commitGate";

function setup(over: Partial<CommitGateDeps> & { loading?: boolean } = {}) {
  const state = { loading: over.loading ?? false, destroyed: false };
  const loadPlaceholder = vi.fn(() => Promise.resolve());
  const gate = createCommitGate({
    isDestroyed: () => state.destroyed,
    isLoading: () => state.loading,
    loadPlaceholder,
    ...over,
  });
  return { gate, state, loadPlaceholder };
}
const flag = (p: Promise<void>) => {
  const f = { done: false, err: null as Error | null };
  p.then(() => (f.done = true), (e: Error) => (f.err = e));
  return f;
};
const tick = () => Promise.resolve().then(() => Promise.resolve());
/** The placeholder commits: start, did-navigate (dom-ready still pending). */
const commitPlaceholder = (gate: ReturnType<typeof setup>["gate"]) => {
  gate.onStartNavigation(BLANK_DOCUMENT_URL);
  gate.onNavigated(BLANK_DOCUMENT_URL);
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("commitGate: ensure only waits", () => {
  it("resolves at once when a document is already committed", async () => {
    const { gate, loadPlaceholder } = setup();
    gate.onNavigated("http://a/");
    await expect(gate.ensure()).resolves.toBeUndefined();
    expect(loadPlaceholder).not.toHaveBeenCalled();
  });

  it("never loads the placeholder, whether or not the tab is loading", async () => {
    for (const loading of [true, false]) {
      const { gate, loadPlaceholder } = setup({ loading });
      void gate.ensure().catch(() => undefined);
      gate.onProgress();
      expect(loadPlaceholder).not.toHaveBeenCalled();
    }
  });

  it("waits for a first navigation in flight", async () => {
    const { gate } = setup({ loading: true });
    const f = flag(gate.ensure());
    await tick();
    expect(f.done).toBe(false);
    gate.onStartNavigation("http://a/");
    gate.onNavigated("http://a/");
    await tick();
    expect(f.done).toBe(true);
  });

  it("counts an error page (dom-ready without did-navigate) as a commit", async () => {
    const { gate } = setup({ loading: true });
    const f = flag(gate.ensure());
    gate.onDomReady();
    await tick();
    expect(f.done).toBe(true);
  });
});

describe("commitGate: placeholder", () => {
  it("startPlaceholder loads it once, and the placeholder is only exposed after commit", () => {
    const { gate, loadPlaceholder } = setup();
    gate.startPlaceholderIfIdle();
    expect(loadPlaceholder).toHaveBeenCalledTimes(1);
    expect(gate.isPlaceholderShown()).toBe(false);
    commitPlaceholder(gate);
    expect(gate.isPlaceholderShown()).toBe(true);
  });

  it("a waiter on the placeholder also waits for its dom-ready (a late one must not satisfy a following open)", async () => {
    const { gate } = setup();
    gate.startPlaceholderIfIdle();
    const f = flag(gate.ensure());
    commitPlaceholder(gate);
    await tick();
    expect(f.done).toBe(false);
    gate.onDomReady();
    await tick();
    expect(f.done).toBe(true);
    // After that, ensure is immediate.
    await expect(gate.ensure()).resolves.toBeUndefined();
  });

  it("reports whether the last dom-ready was the placeholder's, so open can skip it", () => {
    const { gate } = setup();
    gate.startPlaceholderIfIdle();
    commitPlaceholder(gate);
    gate.onDomReady();
    expect(gate.lastDomReadyWasPlaceholder()).toBe(true);
    gate.onStartNavigation("http://a/");
    gate.onNavigated("http://a/");
    gate.onDomReady();
    expect(gate.lastDomReadyWasPlaceholder()).toBe(false);
  });

  it("a caller's navigation that supersedes the placeholder is not mistaken for it", async () => {
    const { gate } = setup();
    gate.startPlaceholderIfIdle();
    const f = flag(gate.ensure());
    gate.onStartNavigation("http://real/"); // supersedes the placeholder before it commits
    gate.onNavigated("http://real/");
    await tick();
    expect(f.done).toBe(true);
    expect(gate.isPlaceholderShown()).toBe(false);
    expect(gate.hasStalePlaceholderEntry()).toBe(false);
  });

  it("a reload of the shown placeholder keeps it the placeholder", () => {
    const { gate } = setup();
    gate.startPlaceholderIfIdle();
    commitPlaceholder(gate);
    gate.onDomReady();
    gate.onStartNavigation(BLANK_DOCUMENT_URL);
    gate.onNavigated(BLANK_DOCUMENT_URL);
    expect(gate.isPlaceholderShown()).toBe(true);
  });

  it("about:blank opened on purpose is not the placeholder", () => {
    const { gate } = setup({ loading: true });
    gate.onStartNavigation(BLANK_DOCUMENT_URL);
    gate.onNavigated(BLANK_DOCUMENT_URL);
    expect(gate.isPlaceholderShown()).toBe(false);
  });

  it("a first navigation aborted with no commit (204, download) loads the placeholder", async () => {
    const { gate, state, loadPlaceholder } = setup({ loading: true });
    gate.onStartNavigation("http://nocontent/");
    const f = flag(gate.ensure());
    state.loading = false;
    gate.onStopLoading();
    expect(loadPlaceholder).toHaveBeenCalledTimes(1);
    commitPlaceholder(gate);
    gate.onDomReady();
    await tick();
    expect(f.done).toBe(true);
    expect(gate.isPlaceholderShown()).toBe(true);
  });

  it("does that even with no waiter yet (emulate arrives later)", () => {
    const { gate, loadPlaceholder } = setup();
    gate.onStopLoading();
    expect(loadPlaceholder).toHaveBeenCalledTimes(1);
  });

  it("does not load on a stop while another navigation is loading, or after a commit", () => {
    const a = setup({ loading: true });
    a.gate.onStopLoading();
    expect(a.loadPlaceholder).not.toHaveBeenCalled();
    const b = setup();
    b.gate.onNavigated("http://a/");
    b.gate.onStopLoading();
    expect(b.loadPlaceholder).not.toHaveBeenCalled();
  });

  it("gives up loading the placeholder after repeated aborts", () => {
    const { gate, loadPlaceholder } = setup();
    for (let i = 0; i < 6; i++) gate.onStopLoading();
    expect(loadPlaceholder).toHaveBeenCalledTimes(3);
  });

  it("startPlaceholderIfIdle does nothing once a navigation started, the tab is loading, or a document committed", () => {
    const a = setup();
    a.gate.onStartNavigation("http://a/");
    a.gate.startPlaceholderIfIdle();
    const b = setup({ loading: true });
    b.gate.startPlaceholderIfIdle();
    const c = setup();
    c.gate.onNavigated("http://a/");
    c.gate.startPlaceholderIfIdle();
    expect(a.loadPlaceholder).not.toHaveBeenCalled();
    expect(b.loadPlaceholder).not.toHaveBeenCalled();
    expect(c.loadPlaceholder).not.toHaveBeenCalled();
  });

  it("a rejected or throwing placeholder load is swallowed", () => {
    const { gate } = setup({ loadPlaceholder: () => Promise.reject(new Error("ERR_ABORTED")) });
    expect(() => gate.startPlaceholderIfIdle()).not.toThrow();
    const t = setup({
      loadPlaceholder: () => {
        throw new Error("destroyed");
      },
    });
    expect(() => t.gate.startPlaceholderIfIdle()).not.toThrow();
  });

  it("an error page committing over the placeholder (dom-ready only) clears the flag", () => {
    const { gate } = setup();
    gate.startPlaceholderIfIdle();
    commitPlaceholder(gate);
    gate.onDomReady(); // the placeholder's own
    expect(gate.isPlaceholderShown()).toBe(true);
    gate.onStartNavigation("http://refused/");
    gate.onDomReady(); // the error page's: no did-navigate
    expect(gate.isPlaceholderShown()).toBe(false);
    expect(gate.hasStalePlaceholderEntry()).toBe(true);
  });
});

describe("commitGate: placeholder history entry", () => {
  it("is stale only once a real page replaced the placeholder, and stays until confirmed removed", () => {
    const { gate } = setup();
    gate.startPlaceholderIfIdle();
    commitPlaceholder(gate);
    gate.onDomReady();
    expect(gate.hasStalePlaceholderEntry()).toBe(false);
    gate.onStartNavigation("http://a/");
    gate.onNavigated("http://a/");
    expect(gate.hasStalePlaceholderEntry()).toBe(true);
    // The removal failed: the caller does not confirm, so the next event retries.
    gate.onNavigated("http://a/b");
    expect(gate.hasStalePlaceholderEntry()).toBe(true);
    gate.placeholderEntryRemoved();
    expect(gate.hasStalePlaceholderEntry()).toBe(false);
  });

  it("is never stale for a tab that never showed the placeholder", () => {
    const { gate } = setup();
    gate.onNavigated("http://a/");
    expect(gate.hasStalePlaceholderEntry()).toBe(false);
  });
});

describe("commitGate: timeout", () => {
  it("rejects after 10 s with no progress and no commit, and can be retried", async () => {
    const { gate } = setup({ timeoutMs: 10_000 });
    const f = flag(gate.ensure());
    vi.advanceTimersByTime(9_999);
    await tick();
    expect(f.err).toBeNull();
    vi.advanceTimersByTime(1);
    await tick();
    expect(f.err?.message).toBe("The tab did not load a document within 10 s.");
    const g = flag(gate.ensure());
    gate.onNavigated("http://a/");
    gate.onDomReady();
    await tick();
    expect(g.done).toBe(true);
  });

  it("navigation start, redirect and loading events extend the timeout", async () => {
    const { gate } = setup({ timeoutMs: 10_000 });
    const f = flag(gate.ensure());
    vi.advanceTimersByTime(9_000);
    gate.onStartNavigation("http://slow/");
    vi.advanceTimersByTime(9_000);
    gate.onProgress(); // redirect
    vi.advanceTimersByTime(9_000);
    await tick();
    expect(f.err).toBeNull();
    gate.onNavigated("http://slow/");
    await tick();
    expect(f.done).toBe(true);
  });

  it("a still-loading tab is given more time, up to a hard cap", async () => {
    const { gate } = setup({ timeoutMs: 1_000, loading: true });
    const f = flag(gate.ensure());
    vi.advanceTimersByTime(5_000);
    await tick();
    expect(f.err).toBeNull();
    vi.advanceTimersByTime(2_000);
    await tick();
    expect(f.err).not.toBeNull();
  });
});

describe("commitGate: renderer crash and teardown", () => {
  it("a crash resets the commit: ensure waits again until the next one", async () => {
    const { gate } = setup();
    gate.onNavigated("http://a/");
    await expect(gate.ensure()).resolves.toBeUndefined();
    gate.onRendererGone();
    const f = flag(gate.ensure());
    await tick();
    expect(f.done).toBe(false);
    gate.onNavigated("http://a/");
    await tick();
    expect(f.done).toBe(true);
  });

  it("a crash forgets that the placeholder was shown", () => {
    const { gate } = setup();
    gate.startPlaceholderIfIdle();
    commitPlaceholder(gate);
    gate.onRendererGone();
    expect(gate.isPlaceholderShown()).toBe(false);
  });

  it("rejects when the tab is destroyed while waiting, and afterwards", async () => {
    const { gate, state } = setup();
    const f = flag(gate.ensure());
    gate.onDestroyed();
    await tick();
    expect(f.err?.message).toMatch(/closed/);
    state.destroyed = true;
    await expect(gate.ensure()).rejects.toThrow(/closed/);
  });
});

describe("commitGate: review fixes", () => {
  it("after a crash a did-stop-loading never loads the placeholder", () => {
    const { gate, loadPlaceholder } = setup();
    gate.onNavigated("http://a/");
    gate.onRendererGone();
    gate.onStopLoading();
    expect(loadPlaceholder).not.toHaveBeenCalled();
  });

  it("a tab that never committed still gets the placeholder after an aborted navigation", () => {
    const { gate, loadPlaceholder } = setup();
    gate.onStopLoading();
    expect(loadPlaceholder).toHaveBeenCalledTimes(1);
  });

  it("a placeholder superseded before its dom-ready does not mark the next dom-ready as its own", async () => {
    const { gate } = setup();
    gate.startPlaceholderIfIdle();
    commitPlaceholder(gate);
    const f = flag(gate.ensure());
    await tick();
    expect(f.done).toBe(false); // placeholder dom-ready pending
    gate.onStartNavigation("http://a/");
    await tick();
    expect(f.done).toBe(true);
    expect(gate.isPlaceholderShown()).toBe(false);
    gate.onDomReady();
    expect(gate.lastDomReadyWasPlaceholder()).toBe(false);
  });

  it("cancelPlaceholder: the stop's did-stop-loading does not reload the placeholder (slow placeholder)", () => {
    let rejectLoad!: (e: Error) => void;
    const loadPlaceholder = vi.fn(() => new Promise<unknown>((_, rej) => (rejectLoad = rej)));
    const { gate } = setup({ loadPlaceholder });
    gate.startPlaceholderIfIdle();
    expect(loadPlaceholder).toHaveBeenCalledTimes(1);
    gate.cancelPlaceholder();
    rejectLoad(new Error("ERR_ABORTED"));
    gate.onStopLoading(); // fired by webContents.stop(), before the real navigation starts
    expect(loadPlaceholder).toHaveBeenCalledTimes(1);
    gate.onStartNavigation("http://a/");
    gate.onNavigated("http://a/");
    expect(gate.isPlaceholderShown()).toBe(false);
    expect(gate.lastDomReadyWasPlaceholder()).toBe(false);
  });

  it("re-arming never extends a wait beyond the hard cap", async () => {
    let t = 0;
    const timers: { fn: () => void; at: number }[] = [];
    const gate = createCommitGate({
      isDestroyed: () => false,
      isLoading: () => true,
      loadPlaceholder: () => Promise.resolve(),
      timeoutMs: 1_000,
      now: () => t,
      setTimer: (fn, ms) => {
        const h = { fn, at: t + ms };
        timers.push(h);
        return h;
      },
      clearTimer: (h) => {
        const i = timers.indexOf(h as (typeof timers)[number]);
        if (i >= 0) timers.splice(i, 1);
      },
    });
    const f = flag(gate.ensure());
    // Progress events keep re-arming; each re-arm must stay within startedAt + 6 s.
    for (t = 500; t < 5_900; t += 500) gate.onProgress();
    t = 5_900;
    gate.onProgress();
    const latest = Math.max(...timers.map((x) => x.at));
    expect(latest).toBeLessThanOrEqual(6_000);
    t = 6_000;
    timers.splice(0).forEach((x) => x.fn());
    await tick();
    expect(f.err).not.toBeNull();
  });

  it("a short ensure timeout does not extend while the tab is loading", async () => {
    const { gate, state } = setup({ loading: true });
    const f = flag(gate.ensure({ timeoutMs: 2_000 }));
    vi.advanceTimersByTime(2_000);
    await tick();
    expect(f.err).not.toBeNull();
    state.loading = true;
  });

  it("a placeholder request whose load throws does not mask a later genuine about:blank", () => {
    const loadPlaceholder = vi.fn(() => {
      throw new Error("destroyed");
    });
    const { gate } = setup({ loadPlaceholder: loadPlaceholder as never });
    gate.startPlaceholderIfIdle();
    gate.onStartNavigation(BLANK_DOCUMENT_URL); // user's own about:blank
    gate.onNavigated(BLANK_DOCUMENT_URL);
    expect(gate.isPlaceholderShown()).toBe(false);
  });

  it("a placeholder request whose load rejects before starting is forgotten", async () => {
    const { gate } = setup({ loadPlaceholder: () => Promise.reject(new Error("aborted")) });
    gate.startPlaceholderIfIdle();
    await tick();
    gate.onStartNavigation(BLANK_DOCUMENT_URL);
    gate.onNavigated(BLANK_DOCUMENT_URL);
    expect(gate.isPlaceholderShown()).toBe(false);
  });

  it("a placeholder request with no navigation start is forgotten after a short time", () => {
    const { gate } = setup({ loadPlaceholder: () => new Promise(() => undefined) });
    gate.startPlaceholderIfIdle();
    vi.advanceTimersByTime(PLACEHOLDER_START_TIMEOUT_MS);
    gate.onStartNavigation(BLANK_DOCUMENT_URL);
    gate.onNavigated(BLANK_DOCUMENT_URL);
    expect(gate.isPlaceholderShown()).toBe(false);
  });

  it("hasDocument tracks the commit and the crash", () => {
    const { gate } = setup();
    expect(gate.hasDocument()).toBe(false);
    gate.onNavigated("http://a/");
    expect(gate.hasDocument()).toBe(true);
    gate.onRendererGone();
    expect(gate.hasDocument()).toBe(false);
  });
});
