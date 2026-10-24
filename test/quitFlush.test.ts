import { describe, expect, it, vi } from "vitest";
import { createQuitFlush } from "../src/main/quitFlush";

function setup(opts: { work?: boolean; flush?: () => Promise<unknown>; timeoutMs?: number } = {}) {
  const state = { work: opts.work ?? true };
  const quit = vi.fn();
  const flushAll = vi.fn(opts.flush ?? (async () => undefined));
  const q = createQuitFlush({ hasWork: () => state.work, flushAll, quit, timeoutMs: opts.timeoutMs });
  const press = () => {
    const event = { preventDefault: vi.fn() };
    const decision = q.onBeforeQuit(event);
    return { event, decision };
  };
  return { q, state, quit, flushAll, press };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("quit flush", () => {
  it("does not hold when there is no canvas work", () => {
    const t = setup({ work: false });
    const { event, decision } = t.press();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(decision.firstPass).toBe(true);
    expect(t.flushAll).not.toHaveBeenCalled();
  });

  it("holds, flushes, quits again; the second pass does not hold", async () => {
    const t = setup();
    const first = t.press();
    expect(first.event.preventDefault).toHaveBeenCalled();
    expect(first.decision.firstPass).toBe(true);
    await tick();
    expect(t.flushAll).toHaveBeenCalledTimes(1);
    expect(t.quit).toHaveBeenCalledTimes(1);
    const second = t.press();
    expect(second.event.preventDefault).not.toHaveBeenCalled();
    expect(second.decision.firstPass).toBe(false);
    expect(t.flushAll).toHaveBeenCalledTimes(1);
  });

  it("a quit pressed during the flush stays held without a second flush", async () => {
    let finish!: () => void;
    const t = setup({ flush: () => new Promise<void>((r) => (finish = r)) });
    t.press();
    const again = t.press();
    expect(again.event.preventDefault).toHaveBeenCalled();
    expect(again.decision.firstPass).toBe(false);
    expect(t.flushAll).toHaveBeenCalledTimes(1);
    finish();
    await tick();
    expect(t.quit).toHaveBeenCalledTimes(1);
  });

  it("gives up after the cap when a page never answers", async () => {
    vi.useFakeTimers();
    try {
      const t = setup({ flush: () => new Promise(() => {}), timeoutMs: 3000 });
      t.press();
      await vi.advanceTimersByTimeAsync(2999);
      expect(t.quit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      expect(t.quit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a flush that throws still quits", async () => {
    const t = setup({ flush: () => { throw new Error("x"); } });
    t.press();
    await tick();
    expect(t.quit).toHaveBeenCalledTimes(1);
  });

  it("a later quit holds again after the second one was cancelled elsewhere", async () => {
    const t = setup();
    t.press();
    await tick();
    // second pass is cancelled by something else: it consumed the flag
    t.press();
    const later = t.press();
    expect(later.event.preventDefault).toHaveBeenCalled();
    expect(later.decision.firstPass).toBe(true);
    await tick();
    expect(t.flushAll).toHaveBeenCalledTimes(2);
  });
});
