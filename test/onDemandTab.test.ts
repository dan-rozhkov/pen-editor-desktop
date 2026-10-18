import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureEditorTab, needsOnDemandTab } from "../src/main/mcp/onDemandTab";

describe("needsOnDemandTab", () => {
  const base = { enabled: true, requestedTabId: undefined, hasActiveTab: false, inFlight: false };
  it("is true with no active tab", () => {
    expect(needsOnDemandTab(base)).toBe(true);
  });
  it("is false without the agent-layout opener (flag off: unchanged)", () => {
    expect(needsOnDemandTab({ ...base, enabled: false })).toBe(false);
  });
  it("is false for an explicit tabId and when a tab is already active", () => {
    expect(needsOnDemandTab({ ...base, requestedTabId: 7 })).toBe(false);
    expect(needsOnDemandTab({ ...base, hasActiveTab: true })).toBe(false);
  });
  it("joins an open already in flight even though its tab is now active", () => {
    expect(needsOnDemandTab({ ...base, hasActiveTab: true, inFlight: true })).toBe(true);
  });
});

describe("ensureEditorTab", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (hasActive = false) => {
    let active = hasActive;
    let ready = false;
    const listeners = new Set<() => void>();
    const open = vi.fn(() => {
      active = true;
    });
    const deps = {
      open,
      hasActiveTab: () => active,
      isReady: () => ready,
      subscribe: (cb: () => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      timeoutMs: 20_000,
    };
    return { deps, open, listeners, register: () => { ready = true; listeners.forEach((l) => l()); } };
  };

  it("opens a tab and resolves true when it registers", async () => {
    const t = make();
    const p = ensureEditorTab(t.deps);
    expect(t.open).toHaveBeenCalledTimes(1);
    t.register();
    await expect(p).resolves.toBe(true);
    expect(t.listeners.size).toBe(0);
  });

  it("does not open a second tab when one is active but still loading", async () => {
    const t = make(true);
    const p = ensureEditorTab(t.deps);
    expect(t.open).not.toHaveBeenCalled();
    t.register();
    await expect(p).resolves.toBe(true);
  });

  it("resolves true at once when the active tab is already registered", async () => {
    const t = make(true);
    t.register();
    await expect(ensureEditorTab(t.deps)).resolves.toBe(true);
  });

  it("resolves false after the injectable timeout and unsubscribes", async () => {
    const t = make();
    const p = ensureEditorTab({ ...t.deps, timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(49);
    expect(t.listeners.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe(false);
    expect(t.listeners.size).toBe(0);
  });
});
