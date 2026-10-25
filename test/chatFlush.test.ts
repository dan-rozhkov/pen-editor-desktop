import { describe, expect, it, vi } from "vitest";
import { CHATS_FLUSH_SCRIPT, flushPanelChats, flushQuitWork, hasQuitWork } from "../src/main/chatFlush";
import { FLUSH_SCRIPT, flushThenClose } from "../src/main/canvasWriters";
import { createQuitFlush } from "../src/main/quitFlush";

describe("chat flush handshake", () => {
  it("runs the chats script, not the canvas one", async () => {
    expect(CHATS_FLUSH_SCRIPT).toBe("typeof window.penChatsFlush === 'function' ? window.penChatsFlush() : undefined");
    const runInPage = vi.fn(async () => undefined);
    await flushPanelChats({ isDestroyed: () => false, runInPage });
    expect(runInPage).toHaveBeenCalledWith(CHATS_FLUSH_SCRIPT);
    expect(runInPage).not.toHaveBeenCalledWith(FLUSH_SCRIPT);
  });

  it("does nothing for a destroyed panel, and is bounded for a page that never settles", async () => {
    const runInPage = vi.fn(async () => undefined);
    await flushPanelChats({ isDestroyed: () => true, runInPage });
    expect(runInPage).not.toHaveBeenCalled();
    await expect(flushPanelChats({ isDestroyed: () => false, runInPage: () => new Promise(() => undefined) }, 20)).resolves.toBeUndefined();
  });

  it("never rejects when the page throws or rejects", async () => {
    await expect(flushPanelChats({ isDestroyed: () => false, runInPage: () => Promise.reject(new Error("x")) })).resolves.toBeUndefined();
    await expect(
      flushPanelChats({
        isDestroyed: () => false,
        runInPage: () => {
          throw new Error("sync");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("a window close flushes the panel with the chats script before closing it", async () => {
    const calls: string[] = [];
    await flushThenClose(
      { isDestroyed: () => false, runInPage: async (s) => void calls.push(s), close: () => void calls.push("close") },
      { script: CHATS_FLUSH_SCRIPT },
    );
    expect(calls).toEqual([CHATS_FLUSH_SCRIPT, "close"]);
  });
});

describe("quit work", () => {
  it("holds for a canvas tab OR an agent panel", () => {
    expect(hasQuitWork({ hasCanvasWork: () => false, panelCount: () => 0 })).toBe(false);
    expect(hasQuitWork({ hasCanvasWork: () => true, panelCount: () => 0 })).toBe(true);
    expect(hasQuitWork({ hasCanvasWork: () => false, panelCount: () => 1 })).toBe(true);
  });

  it("flushes canvas tabs and panels in parallel; one failing does not block the other", async () => {
    const order: string[] = [];
    let release!: () => void;
    const canvas = vi.fn(() => new Promise<void>((r) => (release = r)).then(() => void order.push("canvas")));
    const panels = vi.fn(async () => {
      order.push("panels");
      throw new Error("boom");
    });
    const done = flushQuitWork({ flushCanvasTabs: canvas, flushPanels: panels });
    await Promise.resolve();
    expect(panels).toHaveBeenCalled(); // started while canvas is still pending
    release();
    await expect(done).resolves.toBeUndefined();
    expect(order).toEqual(["panels", "canvas"]);
  });

  it("survives a synchronously throwing flush", async () => {
    const panels = vi.fn(async () => undefined);
    await expect(
      flushQuitWork({
        flushCanvasTabs: () => {
          throw new Error("sync");
        },
        flushPanels: panels,
      }),
    ).resolves.toBeUndefined();
    expect(panels).toHaveBeenCalled();
  });

  it("a quit with only an agent panel is held, flushed and re-issued", async () => {
    const quit = vi.fn();
    const flushPanels = vi.fn(async () => undefined);
    const q = createQuitFlush({
      hasWork: () => hasQuitWork({ hasCanvasWork: () => false, panelCount: () => 1 }),
      flushAll: () => flushQuitWork({ flushCanvasTabs: async () => undefined, flushPanels }),
      quit,
    });
    const event = { preventDefault: vi.fn() };
    expect(q.onBeforeQuit(event).firstPass).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(flushPanels).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });
});
