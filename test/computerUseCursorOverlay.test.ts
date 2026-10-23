import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { made, FakeWin } = vi.hoisted(() => {
  const made: unknown[] = [];
  class FakeWin {
    opts: Record<string, unknown>;
    excludedFromShownWindowsMenu = false;
    setIgnoreMouseEvents = vi.fn();
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setBounds = vi.fn();
    showInactive = vi.fn();
    isVisible = () => false;
    isDestroyed = () => false;
    destroy = vi.fn();
    hide = vi.fn();
    webContents = { executeJavaScript: vi.fn(async (_code: string) => undefined as unknown) };
    loadURL = vi.fn(async () => undefined);
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      made.push(this);
    }
  }
  return { made: made as InstanceType<typeof FakeWin>[], FakeWin };
});
vi.mock("electron", () => ({ BrowserWindow: FakeWin }));

import { CURSOR_JS } from "@sideform/browser-agent/controller";
import { createCursorOverlay, hideAllCursorOverlays, isCursorOverlayWindow } from "../src/main/computerUse/cursorOverlay";

const frame = { x: 10, y: 20, width: 300, height: 200 };

beforeEach(() => {
  made.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("cursor overlay window", () => {
  it("is an inert, taskbar-less, menu-less window kept on every workspace without a process-type change", () => {
    const o = createCursorOverlay({ enabled: () => true });
    o.moveTo({ x: 50, y: 60 }, { action: "hover", windowFrame: frame });
    const w = made[0];
    expect(w.opts).toMatchObject({ focusable: false, skipTaskbar: true, transparent: true, frame: false });
    expect(w.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    expect(w.excludedFromShownWindowsMenu).toBe(true);
    expect(w.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    o.destroy();
  });

  it("is registered so main-window decisions can leave it out", () => {
    const o = createCursorOverlay({ enabled: () => true });
    o.moveTo({ x: 1, y: 1 }, { action: "hover", windowFrame: frame });
    expect(isCursorOverlayWindow(made[0])).toBe(true);
    expect(isCursorOverlayWindow({})).toBe(false);
    expect(isCursorOverlayWindow(undefined)).toBe(false);
    o.destroy();
  });

  it("runs CURSOR_JS with the action and a window-local point", async () => {
    const o = createCursorOverlay({ enabled: () => true });
    await o.moveTo({ x: 50, y: 60 }, { action: "click", windowFrame: frame });
    const w = made[0] as InstanceType<typeof FakeWin>;
    const code = w.webContents.executeJavaScript.mock.calls[0][0] as string;
    expect(code).toContain(CURSOR_JS.slice(0, 200));
    expect(code).toContain('"point":{"x":40,"y":40}');
    expect(code).toContain('"action":"click"');
    expect(code).not.toContain('"from"');
    expect(w.setBounds).toHaveBeenCalledWith({ x: 10, y: 20, width: 300, height: 200 });
    expect(w.showInactive).toHaveBeenCalled();
    o.destroy();
  });

  it("moveTo resolves once executeJavaScript settles", async () => {
    const o = createCursorOverlay({ enabled: () => true });
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((r) => (finish = r));
    let done = false;
    const first = o.moveTo({ x: 1, y: 1 }, { action: "hover", windowFrame: frame });
    await first; // creates the window
    (made[0] as InstanceType<typeof FakeWin>).webContents.executeJavaScript.mockImplementationOnce(() => gate);
    const p = Promise.resolve(o.moveTo({ x: 2, y: 2 }, { action: "hover", windowFrame: frame })).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    finish();
    await p;
    expect(done).toBe(true);
    o.destroy();
  });

  it("moveTo gives up after 900 ms when the page never answers", async () => {
    vi.useFakeTimers();
    const o = createCursorOverlay({ enabled: () => true });
    const first = o.moveTo({ x: 1, y: 1 }, { action: "hover", windowFrame: frame });
    (made[0] as InstanceType<typeof FakeWin>).webContents.executeJavaScript.mockImplementation(() => new Promise<unknown>(() => undefined));
    let done = false;
    void Promise.resolve(first).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(899);
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
    o.destroy();
  });

  it("hides the window 8.4 s after the last move", async () => {
    vi.useFakeTimers();
    const o = createCursorOverlay({ enabled: () => true });
    await o.moveTo({ x: 1, y: 1 }, { action: "hover", windowFrame: frame });
    const w = made[0] as InstanceType<typeof FakeWin>;
    await vi.advanceTimersByTimeAsync(8399);
    expect(w.hide).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(w.hide).toHaveBeenCalled();
    o.destroy();
  });

  it("disables background throttling so the first move after an idle hide animates", () => {
    const o = createCursorOverlay({ enabled: () => true });
    o.moveTo({ x: 1, y: 1 }, { action: "hover", windowFrame: frame });
    expect(made[0].opts.webPreferences).toMatchObject({ backgroundThrottling: false, sandbox: true });
    o.destroy();
  });

  it("re-bounds only on a frame change, then shifts the resting point and waits for the new size first", async () => {
    const o = createCursorOverlay({ enabled: () => true });
    await o.moveTo({ x: 50, y: 60 }, { action: "hover", windowFrame: frame });
    await o.moveTo({ x: 70, y: 80 }, { action: "hover", windowFrame: frame });
    const w = made[0] as InstanceType<typeof FakeWin>;
    expect(w.setBounds).toHaveBeenCalledTimes(1);
    expect(w.webContents.executeJavaScript.mock.calls[1][0]).not.toContain("innerWidth === ");
    await o.moveTo({ x: 70, y: 80 }, { action: "click", windowFrame: { x: 40, y: 25, width: 500, height: 400 } });
    expect(w.setBounds).toHaveBeenCalledTimes(2);
    const code = w.webContents.executeJavaScript.mock.calls[2][0] as string;
    expect(code).toContain("st.pos.x + -30");
    expect(code).toContain("st.pos.y + -5");
    expect(code).toContain("window.innerWidth === 500 && window.innerHeight === 400");
    expect(code).toContain('"point":{"x":30,"y":55}');
    o.destroy();
  });

  it("hideAllCursorOverlays hides a live overlay at once and leaves destroyed ones alone", async () => {
    const a = createCursorOverlay({ enabled: () => true });
    const b = createCursorOverlay({ enabled: () => true });
    await a.moveTo({ x: 1, y: 1 }, { action: "hover", windowFrame: frame });
    await b.moveTo({ x: 1, y: 1 }, { action: "hover", windowFrame: frame });
    b.destroy();
    hideAllCursorOverlays();
    expect(made[0].hide).toHaveBeenCalled();
    expect(made[1].hide).not.toHaveBeenCalled();
    a.destroy();
  });

  it("creates no window while disabled and resolves at once", async () => {
    const o = createCursorOverlay({ enabled: () => false });
    await o.moveTo({ x: 1, y: 1 }, { action: "click", windowFrame: frame });
    expect(made).toHaveLength(0);
    o.destroy();
  });
});
