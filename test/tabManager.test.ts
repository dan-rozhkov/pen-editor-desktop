import { describe, it, expect, vi, beforeEach } from "vitest";
import { TabManager, type TabViewHandle, type TabsSnapshot } from "../src/main/tabManager";

function makeFakeView() {
  let titleCb: ((t: string) => void) | undefined;
  const view = {
    loadURL: vi.fn(),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    destroy: vi.fn(),
    sendMenuCommand: vi.fn(),
    focus: vi.fn(),
    onTitleChanged: vi.fn((cb: (t: string) => void) => {
      titleCb = cb;
    }),
    emitTitle: (t: string) => titleCb?.(t),
  };
  return view as TabViewHandle & { emitTitle: (t: string) => void; loadURL: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; setVisible: ReturnType<typeof vi.fn>; setBounds: ReturnType<typeof vi.fn> };
}

describe("TabManager", () => {
  let views: ReturnType<typeof makeFakeView>[];
  let states: TabsSnapshot[];
  let tm: TabManager;

  beforeEach(() => {
    views = [];
    states = [];
    tm = new TabManager({
      createView: () => {
        const v = makeFakeView();
        views.push(v);
        return v;
      },
      editorUrl: "https://pen-editor.onrender.com",
      onStateChanged: (s) => states.push(s),
    });
  });

  it("newTab loads the editor url and becomes active", () => {
    const id = tm.newTab();
    expect(views[0].loadURL).toHaveBeenCalledWith("https://pen-editor.onrender.com");
    expect(tm.getSnapshot().activeId).toBe(id);
    expect(tm.count()).toBe(1);
  });

  it("second tab hides the first and shows itself", () => {
    tm.newTab();
    tm.newTab();
    expect(views[0].setVisible).toHaveBeenLastCalledWith(false);
    expect(views[1].setVisible).toHaveBeenLastCalledWith(true);
  });

  it("activate switches visibility and focuses", () => {
    const a = tm.newTab();
    tm.newTab();
    tm.activate(a);
    expect(views[0].setVisible).toHaveBeenLastCalledWith(true);
    expect(views[1].setVisible).toHaveBeenLastCalledWith(false);
    expect(tm.getSnapshot().activeId).toBe(a);
  });

  it("closeTab destroys the view and activates a neighbor", () => {
    const a = tm.newTab();
    const b = tm.newTab();
    tm.closeTab(b);
    expect(views[1].destroy).toHaveBeenCalled();
    expect(tm.getSnapshot().activeId).toBe(a);
    expect(tm.count()).toBe(1);
  });

  it("closing the last tab opens a fresh one", () => {
    const a = tm.newTab();
    tm.closeTab(a);
    expect(tm.count()).toBe(1);
    expect(tm.getSnapshot().activeId).not.toBe(a);
  });

  it("next/prev cycle through tabs", () => {
    const a = tm.newTab();
    const b = tm.newTab();
    const c = tm.newTab();
    expect(tm.getSnapshot().activeId).toBe(c);
    tm.nextTab();
    expect(tm.getSnapshot().activeId).toBe(a);
    tm.prevTab();
    expect(tm.getSnapshot().activeId).toBe(c);
    tm.prevTab();
    expect(tm.getSnapshot().activeId).toBe(b);
  });

  it("title changes flow into the snapshot and notify", () => {
    tm.newTab();
    views[0].emitTitle("My Design — Pen");
    const last = states[states.length - 1];
    expect(last.tabs[0].title).toBe("My Design — Pen");
  });

  it("layout positions all tab views below the tab bar", () => {
    tm.newTab();
    tm.newTab();
    tm.layout({ width: 1200, height: 800 }, 38);
    for (const v of views) {
      expect(v.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 38, width: 1200, height: 762 });
    }
  });

  it("every mutation emits a fresh snapshot", () => {
    tm.newTab();
    const before = states.length;
    tm.newTab();
    tm.nextTab();
    expect(states.length).toBeGreaterThan(before + 1);
  });
});
