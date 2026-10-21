import { beforeEach, describe, expect, it, vi } from "vitest";

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
    webContents = { executeJavaScript: vi.fn(async () => undefined) };
    loadURL = vi.fn(async () => undefined);
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      made.push(this);
    }
  }
  return { made: made as InstanceType<typeof FakeWin>[], FakeWin };
});
vi.mock("electron", () => ({ BrowserWindow: FakeWin }));

import { createCursorOverlay, isCursorOverlayWindow } from "../src/main/computerUse/cursorOverlay";

const frame = { x: 10, y: 20, width: 300, height: 200 };

beforeEach(() => {
  made.length = 0;
});

describe("cursor overlay window", () => {
  it("is an inert, taskbar-less, menu-less window kept on every workspace without a process-type change", () => {
    const o = createCursorOverlay({ enabled: () => true });
    o.moveTo({ x: 50, y: 60 }, { click: false, windowFrame: frame });
    const w = made[0];
    expect(w.opts).toMatchObject({ focusable: false, skipTaskbar: true, transparent: true, frame: false });
    expect(w.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    expect(w.excludedFromShownWindowsMenu).toBe(true);
    expect(w.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    o.destroy();
  });

  it("is registered so main-window decisions can leave it out", () => {
    const o = createCursorOverlay({ enabled: () => true });
    o.moveTo({ x: 1, y: 1 }, { click: false, windowFrame: frame });
    expect(isCursorOverlayWindow(made[0])).toBe(true);
    expect(isCursorOverlayWindow({})).toBe(false);
    expect(isCursorOverlayWindow(undefined)).toBe(false);
    o.destroy();
  });
});
