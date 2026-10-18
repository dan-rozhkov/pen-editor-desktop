import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAgentActivity, createTabAgentActivity, isAgentPageCommand, AGENT_ACTIVITY_IDLE_MS } from "../src/main/agentActivity";

describe("createAgentActivity", () => {
  let onChange: ReturnType<typeof vi.fn<(working: boolean) => void>>;
  beforeEach(() => {
    vi.useFakeTimers();
    onChange = vi.fn<(working: boolean) => void>();
  });
  afterEach(() => vi.useRealTimers());

  it("holds for 4 seconds by default", () => {
    expect(AGENT_ACTIVITY_IDLE_MS).toBe(4000);
  });

  it("turns on at the first begin", () => {
    const a = createAgentActivity({ onChange });
    a.begin();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it("stays on while overlapping commands are in flight", () => {
    const a = createAgentActivity({ onChange, idleMs: 100 });
    a.begin();
    a.begin();
    a.end();
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
    a.end();
    vi.advanceTimersByTime(99);
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("keeps working until idleMs after the last end", () => {
    const a = createAgentActivity({ onChange });
    a.begin();
    a.end();
    vi.advanceTimersByTime(AGENT_ACTIVITY_IDLE_MS - 1);
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("a begin inside the idle window cancels the hide and does not re-fire", () => {
    const a = createAgentActivity({ onChange, idleMs: 100 });
    a.begin();
    a.end();
    vi.advanceTimersByTime(60);
    a.begin();
    vi.advanceTimersByTime(500);
    expect(onChange).toHaveBeenCalledTimes(1);
    a.end();
    vi.advanceTimersByTime(100);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("fires again on a new begin after going idle", () => {
    const a = createAgentActivity({ onChange, idleMs: 10 });
    a.begin();
    a.end();
    vi.advanceTimersByTime(10);
    a.begin();
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([true, false, true]);
  });

  it("ignores an unmatched end", () => {
    const a = createAgentActivity({ onChange, idleMs: 10 });
    a.end();
    vi.advanceTimersByTime(100);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses injected timers", () => {
    const set = vi.fn(() => 7);
    const clear = vi.fn();
    const a = createAgentActivity({ onChange, idleMs: 5, setTimeout: set, clearTimeout: clear });
    a.begin();
    a.end();
    expect(set).toHaveBeenCalledWith(expect.any(Function), 5);
    a.begin();
    expect(clear).toHaveBeenCalledWith(7);
  });

  it("begin and end are no-ops after dispose, and no timer is armed", () => {
    const set = vi.fn(() => 1);
    const a = createAgentActivity({ onChange, setTimeout: set });
    a.dispose();
    a.begin();
    a.end();
    expect(onChange).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("a late end after dispose arms no timer", () => {
    const set = vi.fn(() => 1);
    const a = createAgentActivity({ onChange, setTimeout: set });
    a.begin();
    a.dispose();
    a.end();
    expect(set).not.toHaveBeenCalled();
  });

  it("dispose clears the pending hide", () => {
    const a = createAgentActivity({ onChange, idleMs: 100 });
    a.begin();
    a.end();
    a.dispose();
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("isAgentPageCommand", () => {
  it.each(["open", "act", "findImages", "snapshot", "perform", "read", "screenshot", "capture", "applyFixture", "fillLogin"])(
    "%s counts",
    (c) => expect(isAgentPageCommand(c, {})).toBe(true),
  );
  it.each(["startJournal", "stopJournal", "captureCheckpoint", "releaseFixture", "clearActEmulation", "bogus"])("%s does not count", (c) =>
    expect(isAgentPageCommand(c, {})).toBe(false),
  );
  it("tabs counts except action list", () => {
    expect(isAgentPageCommand("tabs", { action: "list" })).toBe(false);
    expect(isAgentPageCommand("tabs", { action: "new" })).toBe(true);
    expect(isAgentPageCommand("tabs", { action: "switch" })).toBe(true);
    expect(isAgentPageCommand("tabs", undefined)).toBe(true);
  });
});

describe("createTabAgentActivity", () => {
  function make() {
    const calls: [number, boolean][] = [];
    const timers: { fn: () => void; ms: number; done: boolean }[] = [];
    const a = createTabAgentActivity({
      onChange: (id, w) => calls.push([id, w]),
      idleMs: 100,
      setTimeout: (fn, ms) => {
        const t = { fn, ms, done: false };
        timers.push(t);
        return t;
      },
      clearTimeout: (h) => {
        (h as { done: boolean }).done = true;
      },
    });
    const fire = () => timers.filter((t) => !t.done).forEach((t) => ((t.done = true), t.fn()));
    return { a, calls, fire };
  }

  it("tracks tabs independently: one finishing leaves the other lit", () => {
    const { a, calls, fire } = make();
    a.begin(1);
    a.begin(2);
    a.end(1);
    fire();
    expect(calls).toEqual([
      [1, true],
      [2, true],
      [1, false],
    ]);
  });

  it("pulse lights a tab and lets it go after the idle hold", () => {
    const { a, calls, fire } = make();
    a.pulse(3);
    expect(calls).toEqual([[3, true]]);
    fire();
    expect(calls).toEqual([
      [3, true],
      [3, false],
    ]);
  });

  it("ignores calls after dispose", () => {
    const { a, calls } = make();
    a.dispose();
    a.begin(1);
    a.pulse(1);
    expect(calls).toEqual([]);
  });
});
