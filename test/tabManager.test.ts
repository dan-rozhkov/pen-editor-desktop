import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TabManager,
  resolveMcpActiveTab,
  shouldFocusAddressBar,
  parseReorderPayload,
  type TabKind,
  type TabViewHandle,
  type TabsSnapshot,
  decideActivationFocus,
} from "../src/main/tabManager";

function makeFakeView() {
  let titleCb: ((t: string) => void) | undefined;
  let themeCb: ((theme: "light" | "dark") => void) | undefined;
  let loadingCb: ((loading: boolean) => void) | undefined;
  let navCb: ((s: { url: string; title: string; canGoBack: boolean; canGoForward: boolean }) => void) | undefined;
  const view = {
    loadURL: vi.fn(() => Promise.resolve()),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    destroy: vi.fn(),
    sendMenuCommand: vi.fn(),
    focus: vi.fn(),
    getWebContentsId: vi.fn(() => 0),
    onDocumentTitleChanged: vi.fn((cb: (t: string) => void) => {
      titleCb = cb;
    }),
    onThemeChanged: vi.fn((cb: (theme: "light" | "dark") => void) => {
      themeCb = cb;
    }),
    onLoadingChanged: vi.fn((cb: (loading: boolean) => void) => {
      loadingCb = cb;
    }),
    onNavigationStateChanged: vi.fn(
      (cb: (s: { url: string; title: string; canGoBack: boolean; canGoForward: boolean }) => void) => {
        navCb = cb;
      },
    ),
    getURL: vi.fn(() => ""),
    getTitle: vi.fn(() => ""),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    executeJavaScript: vi.fn(() => Promise.resolve(null)),
    isLoading: vi.fn(() => false),
    onceDomReady: vi.fn(() => Promise.resolve()),
    emitTitle: (t: string) => titleCb?.(t),
    emitTheme: (theme: "light" | "dark") => themeCb?.(theme),
    emitLoading: (l: boolean) => loadingCb?.(l),
    emitNavState: (s: { url: string; title: string; canGoBack: boolean; canGoForward: boolean }) => navCb?.(s),
  };
  return view as TabViewHandle & {
    emitTitle: (t: string) => void;
    emitTheme: (theme: "light" | "dark") => void;
    emitLoading: (loading: boolean) => void;
    emitNavState: (s: { url: string; title: string; canGoBack: boolean; canGoForward: boolean }) => void;
    loadURL: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    setVisible: ReturnType<typeof vi.fn>;
    setBounds: ReturnType<typeof vi.fn>;
    goBack: ReturnType<typeof vi.fn>;
    goForward: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    getWebContentsId: ReturnType<typeof vi.fn>;
    onDocumentTitleChanged: ReturnType<typeof vi.fn>;
    onThemeChanged: ReturnType<typeof vi.fn>;
    onNavigationStateChanged: ReturnType<typeof vi.fn>;
  };
}

describe("TabManager", () => {
  let views: ReturnType<typeof makeFakeView>[];
  let states: TabsSnapshot[];
  let tm: TabManager;
  let nextWebContentsId: number;

  beforeEach(() => {
    views = [];
    states = [];
    nextWebContentsId = 1;
    tm = new TabManager({
      createView: (_kind: TabKind) => {
        const v = makeFakeView();
        v.getWebContentsId.mockReturnValue(nextWebContentsId++);
        views.push(v);
        return v;
      },
      editorUrl: "https://pen-editor.onrender.com",
      onStateChanged: (s) => states.push(s),
    });
  });

  it("loading flag follows the view, and pushes state only when it changes", () => {
    const e = tm.newTab();
    const b = tm.newTab("browser");
    expect(tm.getSnapshot().tabs.every((t) => !t.loading)).toBe(true);
    const before = states.length;
    views[1].emitLoading(true);
    expect(states.length).toBe(before + 1);
    expect(tm.getSnapshot().tabs.find((t) => t.id === b)?.loading).toBe(true);
    expect(tm.getSnapshot().tabs.find((t) => t.id === e)?.loading).toBeFalsy();
    views[1].emitLoading(true); // repeat: no push
    expect(states.length).toBe(before + 1);
    views[1].emitLoading(false);
    expect(states.length).toBe(before + 2);
    expect(tm.getSnapshot().tabs.find((t) => t.id === b)?.loading).toBeFalsy();
    views[0].emitLoading(true); // editor tabs too
    expect(tm.getSnapshot().tabs.find((t) => t.id === e)?.loading).toBe(true);
  });

  it("a loading event fired synchronously inside loadURL (entry not in the list yet) emits no snapshot", () => {
    const seen: TabsSnapshot[] = [];
    const m = new TabManager({
      createView: () => {
        const v = makeFakeView();
        v.loadURL.mockImplementation(() => {
          v.emitLoading(true); // like webContents did-start-loading firing inside loadURL
          return Promise.resolve();
        });
        return v;
      },
      editorUrl: "https://pen-editor.onrender.com",
      onStateChanged: (s) => seen.push(s),
    });
    m.newTab("editor", undefined, { activate: false });
    // No snapshot lacking the new tab: every emitted snapshot holds it, and carries loading: true.
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.tabs).toHaveLength(1);
    expect(seen[seen.length - 1].tabs[0].loading).toBe(true);
  });

  it("newTab loads the editor url and becomes active", () => {
    const id = tm.newTab();
    expect(views[0].loadURL).toHaveBeenCalledWith("https://pen-editor.onrender.com");
    expect(tm.getSnapshot().activeId).toBe(id);
    expect(tm.count()).toBe(1);
    expect(tm.getSnapshot().tabs[0].title).toBe("Untitled");
    expect(tm.getSnapshot().tabs[0].kind).toBe("editor");
    expect(tm.getSnapshot().activeKind).toBe("editor");
  });

  describe("moveTab", () => {
    const order = () => tm.getSnapshot().tabs.map((t) => t.id);
    let a: number, b: number, c: number, d: number;
    beforeEach(() => {
      a = tm.newTab();
      b = tm.newTab("browser");
      c = tm.newTab();
      d = tm.newTab("doc");
      tm.activate(b);
      states.length = 0;
    });

    it("moves a tab forward (before a later tab)", () => {
      tm.moveTab(a, d);
      expect(order()).toEqual([b, c, a, d]);
    });

    it("moves a tab backward", () => {
      tm.moveTab(d, a);
      expect(order()).toEqual([d, a, b, c]);
    });

    it("beforeId null moves a tab to the end", () => {
      tm.moveTab(a, null);
      expect(order()).toEqual([b, c, d, a]);
    });

    it("is a no-op (and pushes no state) for unknown ids, self, unknown anchor and an unchanged position", () => {
      tm.moveTab(999, a);
      tm.moveTab(a, 999);
      tm.moveTab(a, a);
      tm.moveTab(a, b); // already right before b
      tm.moveTab(d, null); // already last
      expect(order()).toEqual([a, b, c, d]);
      expect(states).toHaveLength(0);
    });

    it("pushes one snapshot in the new order and keeps the active tab, focus and pins", () => {
      const focusCalls = views.map((v) => (v.focus as unknown as ReturnType<typeof vi.fn>).mock.calls.length);
      const pinned = tm.currentBrowserTabId();
      tm.moveTab(b, null);
      expect(states).toHaveLength(1);
      expect(states[0].tabs.map((t) => t.id)).toEqual([a, c, d, b]);
      expect(states[0].activeId).toBe(b);
      expect(tm.getSnapshot().activeId).toBe(b);
      expect(views.map((v) => (v.focus as unknown as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual(focusCalls);
      expect(tm.currentBrowserTabId()).toBe(pinned);
    });

    it("is anchored on ids: a tab opened or closed meanwhile does not misplace it", () => {
      const e = tm.newTab(); // appended after d
      tm.moveTab(a, d);
      expect(order()).toEqual([b, c, a, d, e]);
      tm.closeTab(c);
      tm.moveTab(e, b);
      expect(order()).toEqual([e, b, a, d]);
    });

    it("nextTab / prevTab follow the new order", () => {
      tm.moveTab(a, null); // b c d a, active b
      tm.nextTab();
      expect(tm.getSnapshot().activeId).toBe(c);
      tm.prevTab();
      tm.prevTab();
      expect(tm.getSnapshot().activeId).toBe(a); // wraps backwards from b
    });

    it("editor tabs info follows the strip order (the canvas link sorts by activation itself)", () => {
      tm.moveTab(c, a);
      expect(tm.editorTabsInfo().tabs.map((t) => t.webContentsId)).toEqual([tm.webContentsIdOf(c), tm.webContentsIdOf(a)]);
    });
  });

  describe("parseReorderPayload", () => {
    it("accepts integer ids with an integer or null anchor", () => {
      expect(parseReorderPayload({ id: 3, beforeId: 5 })).toEqual({ id: 3, beforeId: 5 });
      expect(parseReorderPayload({ id: 3, beforeId: null })).toEqual({ id: 3, beforeId: null });
    });

    it("rejects malformed payloads", () => {
      for (const raw of [undefined, null, 5, "x", [], {}, { id: 1 }, { id: 1.5, beforeId: null }, { id: "1", beforeId: null },
        { id: 1, beforeId: "2" }, { id: 1, beforeId: 2.5 }, { id: 1, beforeId: undefined }, { id: Number.NaN, beforeId: null },
        { id: 1, beforeId: Number.POSITIVE_INFINITY }]) {
        expect(parseReorderPayload(raw), JSON.stringify(raw)).toBeNull();
      }
    });
  });

  describe("doc tabs", () => {
    it("load /doc?chat=off (with the id), start titled Document, follow the page title and the theme", () => {
      const id = tm.newTab("doc", undefined, { docId: "d1" });
      expect(views[0].loadURL).toHaveBeenCalledWith("https://pen-editor.onrender.com/doc?id=d1&chat=off");
      let snap = tm.getSnapshot();
      expect(snap).toMatchObject({ activeId: id, activeKind: "doc" });
      expect(snap.tabs[0]).toMatchObject({ kind: "doc", title: "Document" });
      views[0].emitTitle("My notes");
      expect(tm.getSnapshot().tabs[0].title).toBe("My notes");
      views[0].emitTheme("dark");
      snap = tm.getSnapshot();
      expect(snap.activeTheme).toBe("dark");
    });

    it("a doc tab without an id opens a NEW document (new=1) and never matches findDocTab", () => {
      tm.newTab("doc");
      expect(views[0].loadURL).toHaveBeenCalledWith("https://pen-editor.onrender.com/doc?new=1&chat=off");
      expect(tm.findDocTab("new")).toBeNull();
      expect(tm.findDocTab("1")).toBeNull();
      (views[0].getURL as unknown as ReturnType<typeof vi.fn>).mockReturnValue("https://pen-editor.onrender.com/doc?new=1&chat=off");
      expect(tm.findDocTab("x")).toBeNull();
    });

    it("are not canvas tabs: not in the canvas-link list, not the MCP active tab, not lastEditor", () => {
      const editor = tm.newTab("editor");
      const doc = tm.newTab("doc");
      expect(tm.getSnapshot().activeKind).toBe("doc");
      expect(tm.editorTabsInfo()).toEqual({
        tabs: [{ webContentsId: 1, title: "Untitled" }],
        activeWebContentsId: null,
      });
      expect(tm.isEditorTab(2)).toBe(false);
      expect(tm.getSnapshot().mcpActiveWebContentsId).toBe(1);
      tm.activateEditorByWebContentsId(2);
      expect(tm.getSnapshot().activeId).toBe(doc);
      tm.closeTab(editor);
      expect(tm.getSnapshot().mcpActiveWebContentsId).toBeNull();
    });

    it("a lone doc tab never becomes the MCP target", () => {
      tm.newTab("doc");
      expect(tm.getSnapshot().mcpActiveWebContentsId).toBeNull();
      expect(tm.editorTabsInfo().tabs).toEqual([]);
    });

    it("findDocTab matches the opened id, then the live URL once the view reports one", () => {
      const a = tm.newTab("doc", undefined, { docId: "a" });
      tm.newTab("doc", undefined, { docId: "b" });
      tm.newTab("editor");
      expect(tm.findDocTab("a")).toBe(a);
      expect(tm.findDocTab("zzz")).toBeNull();
      (views[0].getURL as unknown as ReturnType<typeof vi.fn>).mockReturnValue("https://pen-editor.onrender.com/doc?id=c&chat=off");
      expect(tm.findDocTab("a")).toBeNull();
      expect(tm.findDocTab("c")).toBe(a);
    });
  });

  describe("trace tabs", () => {
    it("load /trace/<id>?src=local&chat=off, start titled Trace, follow the page title and the theme", () => {
      const id = tm.newTab("trace", undefined, { traceId: "t_1" });
      expect(views[0].loadURL).toHaveBeenCalledWith("https://pen-editor.onrender.com/trace/t_1?src=local&chat=off");
      expect(tm.getSnapshot()).toMatchObject({ activeId: id, activeKind: "trace" });
      expect(tm.getSnapshot().tabs[0]).toMatchObject({ kind: "trace", title: "Trace" });
      views[0].emitTitle("Run: find pricing");
      expect(tm.getSnapshot().tabs[0].title).toBe("Run: find pricing");
      views[0].emitTheme("dark");
      expect(tm.getSnapshot().activeTheme).toBe("dark");
    });

    it("are not canvas tabs and never the MCP target", () => {
      tm.newTab("trace", undefined, { traceId: "t1" });
      expect(tm.editorTabsInfo().tabs).toEqual([]);
      expect(tm.isEditorTab(views[0].getWebContentsId())).toBe(false);
      expect(tm.getSnapshot().mcpActiveWebContentsId).toBeNull();
    });

    it("without a valid trace id no tab and no view is created", () => {
      for (const bad of [undefined, "", "../x", "a b"]) {
        expect(() => tm.newTab("trace", undefined, { traceId: bad })).toThrow(/trace id/);
      }
      expect(views).toHaveLength(0);
      expect(tm.getSnapshot().tabs).toEqual([]);
    });

    it("listTraceTabs keeps strip order, prefers the live URL id, flags the active tab and skips non-trace tabs", () => {
      const a = tm.newTab("trace", undefined, { traceId: "a" });
      tm.newTab("doc", undefined, { docId: "d" });
      tm.newTab("trace", undefined, { traceId: "b" });
      (views[2].getURL as unknown as ReturnType<typeof vi.fn>).mockReturnValue("https://pen-editor.onrender.com/trace/z?src=local&chat=off");
      tm.activate(a);
      expect(tm.listTraceTabs()).toEqual([
        { traceId: "a", title: "Trace", active: true },
        { traceId: "z", title: "Trace", active: false },
      ]);
    });

    it("findTraceTab falls back to the opened id when the live URL has none (offline page, redirect)", () => {
      const a = tm.newTab("trace", undefined, { traceId: "a" });
      (views[0].getURL as unknown as ReturnType<typeof vi.fn>).mockReturnValue("file:///app/assets/offline.html");
      expect(tm.findTraceTab("a")).toBe(a);
    });

    it("findTraceTab matches the opened id, then the live URL; isTraceTab matches the webContents id", () => {
      const a = tm.newTab("trace", undefined, { traceId: "a" });
      tm.newTab("doc", undefined, { docId: "a" });
      expect(tm.findTraceTab("a")).toBe(a);
      expect(tm.findTraceTab("zzz")).toBeNull();
      (views[0].getURL as unknown as ReturnType<typeof vi.fn>).mockReturnValue("https://pen-editor.onrender.com/trace/c?src=local&chat=off");
      expect(tm.findTraceTab("a")).toBeNull();
      expect(tm.findTraceTab("c")).toBe(a);
      expect(tm.isTraceTab(views[0].getWebContentsId())).toBe(true);
      expect(tm.isTraceTab(views[1].getWebContentsId())).toBe(false);
      expect(tm.isTraceTab(99)).toBe(false);
    });

    it("isTraceViewer needs a trace tab that still shows /trace/<id>; isActiveTabWebContents follows the active tab", () => {
      const a = tm.newTab("trace", undefined, { traceId: "a" });
      const doc = tm.newTab("doc", undefined, { docId: "d" });
      const traceWc = views[0].getWebContentsId();
      (views[0].getURL as unknown as ReturnType<typeof vi.fn>).mockReturnValue("https://pen-editor.onrender.com/trace/a?src=local");
      (views[1].getURL as unknown as ReturnType<typeof vi.fn>).mockReturnValue("https://pen-editor.onrender.com/trace/a?src=local");
      expect(tm.isTraceViewer(traceWc)).toBe(true);
      expect(tm.isTraceViewer(views[1].getWebContentsId())).toBe(false);
      (views[0].getURL as unknown as ReturnType<typeof vi.fn>).mockReturnValue("https://pen-editor.onrender.com/app");
      expect(tm.isTraceViewer(traceWc)).toBe(false);
      tm.activate(a);
      expect(tm.isActiveTabWebContents(traceWc)).toBe(true);
      tm.activate(doc);
      expect(tm.isActiveTabWebContents(traceWc)).toBe(false);
    });
  });

  it("newTab with activate:false opens in the background without activating or emitting an activation", () => {
    const first = tm.newTab();
    const browser = tm.newTab("browser");
    tm.activate(first);
    const before = states.length;
    const bg = tm.newTab("editor", undefined, { activate: false });
    const snap = tm.getSnapshot();
    expect(snap.activeId).toBe(first);
    expect(snap.tabs.map((t) => t.id)).toContain(bg);
    expect(views[2].setVisible).toHaveBeenLastCalledWith(false);
    expect(views[2].loadURL).toHaveBeenCalled();
    expect(states.length).toBe(before + 1);
    expect(states[states.length - 1].activeId).toBe(first);
    // The agent's browser pin was not touched.
    expect(tm.currentBrowserTabId(undefined)).toBe(browser);
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

  it("activate with focus:false shows the tab without focusing its view", () => {
    const a = tm.newTab();
    tm.newTab();
    const before = vi.mocked(views[0].focus).mock.calls.length;
    tm.activate(a, { focus: false });
    expect(views[0].setVisible).toHaveBeenLastCalledWith(true);
    expect(tm.getSnapshot().activeId).toBe(a);
    expect(vi.mocked(views[0].focus).mock.calls.length).toBe(before);
    tm.activate(a);
    expect(vi.mocked(views[0].focus).mock.calls.length).toBe(before + 1);
  });

  it("newTab with focus:false becomes active but is not focused", () => {
    tm.newTab();
    const d = tm.newTab("doc", undefined, { docId: "abc", focus: false });
    expect(tm.getSnapshot().activeId).toBe(d);
    expect(views[1].setVisible).toHaveBeenLastCalledWith(true);
    expect(views[1].focus).not.toHaveBeenCalled();
  });

  it("closeTab destroys the view and activates a neighbor", () => {
    const a = tm.newTab();
    const b = tm.newTab();
    tm.closeTab(b);
    expect(views[1].destroy).toHaveBeenCalled();
    expect(tm.getSnapshot().activeId).toBe(a);
    expect(tm.count()).toBe(1);
  });

  it("closeTab does not corrupt state when destroy() throws", () => {
    const a = tm.newTab();
    const b = tm.newTab();
    views[1].destroy.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => tm.closeTab(b)).not.toThrow();
    expect(views[1].destroy).toHaveBeenCalled();
    const snapshot = tm.getSnapshot();
    expect(snapshot.activeId).toBe(a);
    expect(snapshot.activeId).not.toBe(b);
    expect(tm.activeHandle()).toBe(views[0]);
    expect(tm.count()).toBe(1);
    const last = states[states.length - 1];
    expect(last.activeId).toBe(a);
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

  it("document title changes flow into the snapshot and notify", () => {
    tm.newTab();
    views[0].emitTitle("My Design — Pen");
    const last = states[states.length - 1];
    expect(last.tabs[0].title).toBe("My Design — Pen");
  });

  it("reports the active editor theme and follows it when tabs switch", () => {
    const lightTab = tm.newTab();
    views[0].emitTheme("light");
    tm.newTab();
    views[1].emitTheme("dark");
    expect(tm.getSnapshot().activeTheme).toBe("dark");
    tm.activate(lightTab);
    expect(tm.getSnapshot().activeTheme).toBe("light");
  });

  // Glass tab bar work, 2026-09-25: a browser tab has no theme of its own
  // (no preload, so no editor:theme IPC), and used to report `null` —
  // falling back to the system theme in window.ts and visibly flipping the
  // bar's color scheme relative to whatever editor tab is open elsewhere in
  // the strip. `activeTheme` must instead inherit the last-active editor
  // tab's theme.
  it("a browser tab inherits the last-active editor tab's theme", () => {
    const editor = tm.newTab("editor");
    views[0].emitTheme("dark");
    tm.newTab("browser");
    expect(tm.getSnapshot().activeKind).toBe("browser");
    expect(tm.getSnapshot().activeTheme).toBe("dark");
    // Activating the editor tab directly still reports its own theme.
    tm.activate(editor);
    expect(tm.getSnapshot().activeTheme).toBe("dark");
  });

  it("updates the snapshot when the last-active editor tab's theme changes while a browser tab is active", () => {
    tm.newTab("editor");
    views[0].emitTheme("light");
    tm.newTab("browser");
    expect(tm.getSnapshot().activeTheme).toBe("light");

    const before = states.length;
    views[0].emitTheme("dark");
    // The theme-change callback on an inactive editor tab must still push a
    // fresh snapshot — not just update internal state silently.
    expect(states.length).toBe(before + 1);
    expect(tm.getSnapshot().activeTheme).toBe("dark");
    expect(states[states.length - 1].activeTheme).toBe("dark");
  });

  it("falls back to any editor tab with a known theme when the last-active one has none yet", () => {
    tm.newTab("editor"); // views[0]
    views[0].emitTheme("dark");
    tm.newTab("editor"); // views[1] — now the last-active editor, no theme yet
    tm.newTab("browser");
    expect(tm.getSnapshot().activeKind).toBe("browser");
    expect(tm.getSnapshot().activeTheme).toBe("dark");
  });

  it("reports null when no editor tab has ever reported a theme", () => {
    tm.newTab("editor");
    tm.newTab("browser");
    expect(tm.getSnapshot().activeKind).toBe("browser");
    expect(tm.getSnapshot().activeTheme).toBeNull();
  });

  it("defaults mcpStatus to off and reports it in the snapshot", () => {
    tm.newTab();
    expect(tm.getSnapshot().mcpStatus).toBe("off");
  });

  it("setMcpStatus updates the snapshot and emits a fresh state", () => {
    tm.newTab();
    const before = states.length;
    tm.setMcpStatus("listening");
    expect(tm.getSnapshot().mcpStatus).toBe("listening");
    expect(states.length).toBe(before + 1);
    expect(states[states.length - 1].mcpStatus).toBe("listening");
  });

  it("setMcpStatus is a no-op (no extra emit) when the status is unchanged", () => {
    tm.newTab();
    tm.setMcpStatus("not-published");
    const before = states.length;
    tm.setMcpStatus("not-published");
    expect(states.length).toBe(before);
  });

  it("layout applies the rect it is given (computed by layout.ts) to every tab view", () => {
    tm.newTab();
    tm.layout({ x: 1, y: 38, width: 1198, height: 761 });
    expect(views[0].setBounds).toHaveBeenLastCalledWith({ x: 1, y: 38, width: 1198, height: 761 });
  });

  it("layoutActive moves only the active tab view, and later tabs get the latest rect", () => {
    const a = tm.newTab();
    tm.newTab();
    tm.activate(a);
    for (const v of views) v.setBounds.mockClear();
    tm.layoutActive({ x: 100, y: 38, width: 500, height: 700 });
    expect(views[0].setBounds).toHaveBeenCalledTimes(1);
    expect(views[0].setBounds).toHaveBeenLastCalledWith({ x: 100, y: 38, width: 500, height: 700 });
    expect(views[1].setBounds).not.toHaveBeenCalled();
    // A tab opened mid-slide is placed at the latest frame.
    tm.newTab();
    expect(views[2].setBounds).toHaveBeenLastCalledWith({ x: 100, y: 38, width: 500, height: 700 });
    // The final full layout reaches the hidden tab views too.
    tm.layout({ x: 8, y: 38, width: 900, height: 700 });
    expect(views[1].setBounds).toHaveBeenLastCalledWith({ x: 8, y: 38, width: 900, height: 700 });
  });

  it("layoutActive with no active tab only records the rect", () => {
    const empty = new TabManager({
      createView: () => makeFakeView(),
      editorUrl: "https://pen-editor.onrender.com",
      onStateChanged: () => {},
    });
    expect(() => empty.layoutActive({ x: 1, y: 2, width: 3, height: 4 })).not.toThrow();
  });

  it("layout positions all tab views below the tab bar", () => {
    tm.newTab();
    tm.newTab();
    tm.layout({ x: 380, y: 38, width: 820, height: 762 });
    for (const v of views) {
      expect(v.setBounds).toHaveBeenLastCalledWith({ x: 380, y: 38, width: 820, height: 762 });
    }
  });

  it("every mutation emits a fresh snapshot", () => {
    tm.newTab();
    const before = states.length;
    tm.newTab();
    tm.nextTab();
    expect(states.length).toBeGreaterThan(before + 1);
  });

  it("destroyAll destroys every tab view and does not respawn a fresh tab", () => {
    tm.newTab();
    tm.newTab();
    tm.newTab();
    tm.destroyAll();
    for (const v of views) {
      expect(v.destroy).toHaveBeenCalled();
    }
    expect(tm.count()).toBe(0);
  });

  it("destroyAll tolerates a view whose destroy() throws", () => {
    tm.newTab();
    tm.newTab();
    views[0].destroy.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => tm.destroyAll()).not.toThrow();
    expect(views[1].destroy).toHaveBeenCalled();
    expect(tm.count()).toBe(0);
  });

  describe("browser tabs", () => {
    it("newTab(\"browser\") does not load the editor url, defaults title to New Tab, and does not wire title/theme callbacks", () => {
      const id = tm.newTab("browser");
      expect(views[0].loadURL).not.toHaveBeenCalled();
      expect(views[0].onDocumentTitleChanged).not.toHaveBeenCalled();
      expect(views[0].onThemeChanged).not.toHaveBeenCalled();
      expect(views[0].onNavigationStateChanged).toHaveBeenCalled();
      const snap = tm.getSnapshot();
      expect(snap.tabs[0].kind).toBe("browser");
      expect(snap.tabs[0].title).toBe("New Tab");
      expect(snap.activeId).toBe(id);
      expect(snap.activeKind).toBe("browser");
    });

    it("navigation state updates flow into the snapshot", () => {
      tm.newTab("browser");
      views[0].emitNavState({ url: "https://example.com/", title: "Example", canGoBack: true, canGoForward: false });
      const last = states[states.length - 1];
      expect(last.tabs[0]).toMatchObject({
        title: "Example",
        url: "https://example.com/",
        canGoBack: true,
        canGoForward: false,
      });
    });

    it("an empty title falls back to New Tab", () => {
      tm.newTab("browser");
      views[0].emitNavState({ url: "https://example.com/", title: "  ", canGoBack: false, canGoForward: false });
      expect(tm.getSnapshot().tabs[0].title).toBe("New Tab");
    });

    it("editor tabs are unaffected by browser-tab wiring (editor tabs still get title/theme callbacks, not onNavigationStateChanged use)", () => {
      tm.newTab("editor");
      expect(views[0].onDocumentTitleChanged).toHaveBeenCalled();
      expect(views[0].onThemeChanged).toHaveBeenCalled();
    });

    it("browserHandle returns null when there is no browser tab", () => {
      tm.newTab("editor");
      expect(tm.browserHandle()).toBeNull();
    });

    it("browserHandle returns the active browser tab when it is active", () => {
      tm.newTab("editor");
      const b = tm.newTab("browser");
      expect(tm.getSnapshot().activeId).toBe(b);
      expect(tm.browserHandle()).toBe(views[1]);
    });

    it("browserHandle falls back to the most recently created browser tab when a different (editor) tab is active", () => {
      tm.newTab("browser"); // views[0]
      tm.newTab("browser"); // views[1]
      const e = tm.newTab("editor"); // views[2], becomes active
      expect(tm.getSnapshot().activeId).toBe(e);
      expect(tm.browserHandle()).toBe(views[1]);
    });

    // Full browser use (design doc `2026-09-23-full-browser-use-design.md`):
    // agentBrowserTabId — fixes upstream jev-ultrafast #61.
    it("browserHandle prefers agentBrowserTabId over the active-tab rule", () => {
      const b1 = tm.newTab("browser"); // views[0]
      tm.newTab("browser"); // views[1], becomes active
      expect(tm.getSnapshot().activeId).not.toBe(b1);
      tm.setAgentBrowserTabId(b1);
      // Without agentBrowserTabId this would fall back to the active tab
      // (views[1]) — the whole point of the override.
      expect(tm.browserHandle()).toBe(views[0]);
    });

    it("browserHandle falls back to the default rule when agentBrowserTabId points at an editor tab or a closed tab", () => {
      const e = tm.newTab("editor");
      const b = tm.newTab("browser");
      tm.setAgentBrowserTabId(e); // not a browser tab at all
      expect(tm.browserHandle()).toBe(views[1]); // falls back to active-if-browser

      tm.setAgentBrowserTabId(999); // never existed
      expect(tm.browserHandle()).toBe(views[1]);

      tm.setAgentBrowserTabId(b);
      tm.closeTab(b);
      // The tab agentBrowserTabId pointed at is gone, and it was the only
      // browser tab — browserHandle must not keep resolving to a
      // stale/destroyed view; it has nothing left to fall back to either.
      expect(tm.browserHandle()).toBeNull();
    });

    it("closing the agent's browser tab clears agentBrowserTabId rather than leaving it dangling", () => {
      tm.newTab("editor"); // views[0]
      const b1 = tm.newTab("browser"); // views[1]
      tm.newTab("browser"); // views[2], becomes active
      tm.setAgentBrowserTabId(b1);
      tm.closeTab(b1);
      // The active tab (views[2], a browser tab) is untouched by the close
      // — browserHandle's default rule (active-if-browser) must be free to
      // pick it, which it couldn't if agentBrowserTabId still pointed at
      // the closed b1's id.
      expect(tm.browserHandle()).toBe(views[2]);
    });

    it("listBrowserTabs reports every browser tab and marks browserHandle()'s pick current", () => {
      tm.newTab("editor");
      const b1 = tm.newTab("browser");
      const b2 = tm.newTab("browser");
      views[1].emitNavState({ url: "https://a.example/", title: "A", canGoBack: false, canGoForward: false });
      views[2].emitNavState({ url: "https://b.example/", title: "B", canGoBack: false, canGoForward: false });
      tm.setAgentBrowserTabId(b1);
      const list = tm.listBrowserTabs();
      expect(list).toEqual([
        { tabId: b1, url: "https://a.example/", title: "A", current: true },
        { tabId: b2, url: "https://b.example/", title: "B", current: false },
      ]);
    });

    it("isEditorTab is true only for editor tabs' webContents ids", () => {
      tm.newTab("editor");
      tm.newTab("browser");
      const editorWcId = views[0].getWebContentsId();
      const browserWcId = views[1].getWebContentsId();
      expect(tm.isEditorTab(editorWcId)).toBe(true);
      expect(tm.isEditorTab(browserWcId)).toBe(false);
      expect(tm.isEditorTab(999)).toBe(false);
    });

    it("activeKind tracks the active tab's kind across activation", () => {
      const e = tm.newTab("editor");
      const b = tm.newTab("browser");
      expect(tm.getSnapshot().activeKind).toBe("browser");
      tm.activate(e);
      expect(tm.getSnapshot().activeKind).toBe("editor");
      tm.activate(b);
      expect(tm.getSnapshot().activeKind).toBe("browser");
    });

    // Review finding 4: browserHandle() used to keep preferring a stale
    // agentBrowserTabId even after the user activated a *different* browser
    // tab (a tab-strip click) — the very next browser command would then
    // silently act on the tab the user had left, not the one they were
    // looking at.
    it("activate() on a browser tab repoints agentBrowserTabId — the agent follows the user's focus", () => {
      const b1 = tm.newTab("browser"); // views[0]
      const b2 = tm.newTab("browser"); // views[1], becomes active
      tm.setAgentBrowserTabId(b1);
      expect(tm.browserHandle()).toBe(views[0]);

      tm.activate(b2);
      expect(tm.browserHandle()).toBe(views[1]);
    });

    it("activate() on an editor tab does not touch agentBrowserTabId", () => {
      const b1 = tm.newTab("browser"); // views[0]
      const e = tm.newTab("editor"); // views[1]
      tm.setAgentBrowserTabId(b1);
      tm.activate(e);
      // Falls back to the default rule (no active browser tab, most recent
      // one) rather than losing the explicit agent tab — activating an
      // editor tab is not "the user looked at a different browser tab".
      expect(tm.browserHandle()).toBe(views[0]);
    });

    it("activate() with an unknown id is a no-op (mirrors the existing leniency, doesn't touch agentBrowserTabId)", () => {
      const b1 = tm.newTab("browser");
      tm.setAgentBrowserTabId(b1);
      tm.activate(999);
      expect(tm.browserHandle()).toBe(views[0]);
    });

    // Second-pass review finding 3: a user-driven tab cycle (nextTab/
    // prevTab — Ctrl+Tab/Ctrl+Shift+Tab) landing on a browser tab repoints
    // the agent to it, the same way activate() (a tab-strip click) already
    // does.
    describe("nextTab/prevTab repoint the agent on a browser tab (finding 3)", () => {
      it("nextTab landing on a browser tab repoints agentBrowserTabId", () => {
        const b1 = tm.newTab("browser"); // views[0]
        const e = tm.newTab("editor"); // views[1]
        const b2 = tm.newTab("browser"); // views[2], active
        tm.setAgentBrowserTabId(b1);
        expect(tm.browserHandle()).toBe(views[0]);

        tm.activate(e); // land on the editor tab first, agentBrowserTabId untouched by that
        expect(tm.getSnapshot().activeId).toBe(e);

        tm.nextTab(); // e -> b2 (wraps around the 3-tab order: b1, e, b2)
        expect(tm.getSnapshot().activeId).toBe(b2);
        expect(tm.browserHandle()).toBe(views[2]);
      });

      it("prevTab landing on a browser tab repoints agentBrowserTabId", () => {
        const b1 = tm.newTab("browser"); // views[0]
        const b2 = tm.newTab("browser"); // views[1]
        tm.newTab("editor"); // views[2], active
        // Point the agent at b1 — b2, not b1, is the one prevTab is about
        // to land on (order: b1, b2, editor), so the fallback rule
        // ("active if browser, else most recent") could never independently
        // produce b2 here; only an actual repoint by prevTab can.
        tm.setAgentBrowserTabId(b1);
        expect(tm.browserHandle()).toBe(views[0]);

        tm.prevTab(); // editor -> b2
        expect(tm.getSnapshot().activeId).toBe(b2);
        expect(tm.browserHandle()).toBe(views[1]);
      });

      it("cycling to an editor tab does not touch agentBrowserTabId", () => {
        const b1 = tm.newTab("browser"); // views[0]
        tm.newTab("editor"); // views[1], active
        tm.setAgentBrowserTabId(b1);
        tm.nextTab(); // editor -> b1 (wraps)
        tm.nextTab(); // b1 -> editor
        expect(tm.getSnapshot().activeKind).toBe("editor");
        // agentBrowserTabId is still b1 — cycling onto the editor tab must
        // not have cleared or changed it.
        expect(tm.browserHandle()).toBe(views[0]);
      });
    });

    // Second-pass review finding 2: window.ts's ensurePage/popup callback
    // need the *id* of whichever browser tab browserHandle() would return,
    // to pin agentBrowserTabId even when handing back an existing tab.
    describe("currentBrowserTabId", () => {
      it("returns null when there is no browser tab", () => {
        tm.newTab("editor");
        expect(tm.currentBrowserTabId()).toBeNull();
      });

      it("matches whichever tab browserHandle() resolves to", () => {
        const b1 = tm.newTab("browser");
        tm.newTab("browser");
        tm.setAgentBrowserTabId(b1);
        expect(tm.currentBrowserTabId()).toBe(b1);
        expect(tm.browserHandle()).toBe(views[0]);
      });
    });

    // Third-pass review: the address row must drive the tab it is SHOWING,
    // even when the agent is pinned to a different (hidden) browser tab.
    describe("activeBrowserHandle", () => {
      it("is the visible browser tab, not the agent's pinned one", () => {
        const b1 = tm.newTab("browser");
        tm.newTab("browser"); // becomes active
        tm.setAgentBrowserTabId(b1);
        expect(tm.browserHandle()).toBe(views[0]);
        expect(tm.activeBrowserHandle()).toBe(views[1]);
      });

      it("is null while an editor tab is active", () => {
        tm.newTab("browser");
        tm.newTab("editor");
        expect(tm.activeBrowserHandle()).toBeNull();
      });
    });

    // Review finding 6: dialog draining needs every open browser tab's own
    // handle, not just browserHandle()'s single pick.
    describe("browserTabHandleById", () => {
      it("returns the view for a live browser tab by id", () => {
        const b1 = tm.newTab("browser");
        const b2 = tm.newTab("browser");
        expect(tm.browserTabHandleById(b1)).toBe(views[0]);
        expect(tm.browserTabHandleById(b2)).toBe(views[1]);
      });

      it("returns null for an editor tab id, and for an id that doesn't exist", () => {
        const e = tm.newTab("editor");
        expect(tm.browserTabHandleById(e)).toBeNull();
        expect(tm.browserTabHandleById(999)).toBeNull();
      });

      it("returns null once the tab has been closed", () => {
        const b = tm.newTab("browser");
        tm.newTab("browser"); // keep at least one browser tab open after closing b
        tm.closeTab(b);
        expect(tm.browserTabHandleById(b)).toBeNull();
      });
    });
  });
});

// Finding 1: activating a browser tab must not knock out
// McpService.getActiveTab() for un-targeted tools/call requests while an
// editor tab is still open elsewhere in the strip.
describe("resolveMcpActiveTab", () => {
  it("reports the active webContents id while an editor tab is active", () => {
    expect(resolveMcpActiveTab("editor", 7, null)).toBe(7);
    expect(resolveMcpActiveTab("editor", 7, 3)).toBe(7);
  });

  it("falls back to the last active editor tab id while a browser tab is active, instead of nulling it out", () => {
    expect(resolveMcpActiveTab("browser", 9, 3)).toBe(3);
  });

  it("stays null while a browser tab is active and no editor tab has ever been active", () => {
    expect(resolveMcpActiveTab("browser", 9, null)).toBeNull();
  });

  it("falls back to the last editor tab id when there is no active tab at all (activeKind null)", () => {
    expect(resolveMcpActiveTab(null, null, 3)).toBe(3);
  });
});

describe("agentTabIds", () => {
  function make() {
    const states: TabsSnapshot[] = [];
    let n = 1;
    const tm = new TabManager({
      createView: () => {
        const v = makeFakeView();
        v.getWebContentsId.mockReturnValue(n++);
        return v;
      },
      editorUrl: "https://pen-editor.onrender.com",
      onStateChanged: (s) => states.push(s),
    });
    return { tm, states };
  }

  it("is empty when no tab is marked", () => {
    const { tm } = make();
    tm.newTab();
    tm.newTab("browser");
    expect(tm.getSnapshot().agentTabIds).toEqual([]);
  });

  it("lists every marked browser tab, each cleared on its own", () => {
    const { tm } = make();
    tm.newTab();
    const b1 = tm.newTab("browser");
    const b2 = tm.newTab("browser", "s");
    tm.setAgentTabWorking(b1, true);
    tm.setAgentTabWorking(b2, true);
    expect(tm.getSnapshot().agentTabIds).toEqual([b1, b2]);
    tm.setAgentTabWorking(b1, false);
    expect(tm.getSnapshot().agentTabIds).toEqual([b2]);
  });

  it("drops a tab that closes, without moving the mark to another tab", () => {
    const { tm } = make();
    const b1 = tm.newTab("browser");
    const b2 = tm.newTab("browser");
    tm.setAgentTabWorking(b1, true);
    tm.closeTab(b1);
    expect(tm.getSnapshot().tabs.some((t) => t.id === b2)).toBe(true);
    expect(tm.getSnapshot().agentTabIds).toEqual([]);
  });

  it("does not move when the user activates another browser tab", () => {
    const { tm } = make();
    const b1 = tm.newTab("browser");
    const b2 = tm.newTab("browser");
    tm.setAgentTabWorking(b1, true);
    tm.activate(b2);
    expect(tm.getSnapshot().agentTabIds).toEqual([b1]);
  });

  it("ignores an editor tab", () => {
    const { tm } = make();
    const e = tm.newTab();
    tm.setAgentTabWorking(e, true);
    expect(tm.getSnapshot().agentTabIds).toEqual([]);
  });

  it("emits only on change", () => {
    const { tm, states } = make();
    const b = tm.newTab("browser");
    const before = states.length;
    tm.setAgentTabWorking(b, true);
    tm.setAgentTabWorking(b, true);
    tm.setAgentTabWorking(b, false);
    tm.setAgentTabWorking(b, false);
    expect(states.length).toBe(before + 2);
  });
});

// Finding 1 regression: closing the active *editor* tab whose neighbor is a
// browser tab used to leave TabManager's internal "last editor tab" pointer
// aimed at the now-destroyed webContents id — the exact regression
// resolveMcpActiveTab was added to prevent, surfacing as "No editor tab is
// open" MCP errors even while another editor tab is still open elsewhere in
// the strip.
describe("mcpActiveWebContentsId (finding 1)", () => {
  let views: ReturnType<typeof makeFakeView>[];
  let tm: TabManager;
  let nextWebContentsId: number;

  beforeEach(() => {
    views = [];
    nextWebContentsId = 1;
    tm = new TabManager({
      createView: (_kind: TabKind) => {
        const v = makeFakeView();
        v.getWebContentsId.mockReturnValue(nextWebContentsId++);
        views.push(v);
        return v;
      },
      editorUrl: "https://pen-editor.onrender.com",
      onStateChanged: () => {},
    });
  });

  it("repoints to a surviving editor tab when the active editor tab is closed next to a browser tab", () => {
    tm.newTab("editor"); // views[0] — editorA, will survive
    tm.newTab("browser"); // views[1]
    const editorB = tm.newTab("editor"); // views[2] — active, will be closed
    // Close the active editor tab — its neighbor (idx - 1) is the browser tab.
    tm.closeTab(editorB);

    const snapshot = tm.getSnapshot();
    expect(snapshot.activeKind).toBe("browser");
    // Must repoint to the surviving editor tab (editorA), never to editorB's
    // now-destroyed webContents id, and never null while an editor tab is
    // still open — the exact "No editor tab is open" regression.
    expect(snapshot.mcpActiveWebContentsId).toBe(views[0].getWebContentsId());
  });

  it("nulls out mcpActiveWebContentsId when the last editor tab is closed and no other editor tab exists", () => {
    tm.newTab("browser");
    const onlyEditor = tm.newTab("editor");
    tm.activate(onlyEditor);
    tm.closeTab(onlyEditor);

    // closeTab always respawns... no: respawning only happens when *all*
    // tabs (including browser tabs) are gone. Here the browser tab survives,
    // so no editor tab remains and mcpActiveWebContentsId must be null.
    const snapshot = tm.getSnapshot();
    expect(snapshot.tabs.some((t) => t.kind === "editor")).toBe(false);
    expect(snapshot.mcpActiveWebContentsId).toBeNull();
  });
});

// The new-browser-tab focus fix: File ▸ New Browser Tab used to leave a
// blank content area with an unfocused, empty address bar and no cue where
// to type. shouldFocusAddressBar is the pure predicate window.ts's
// pushState uses to decide, on every snapshot push, whether this is the one
// push that should move focus into #url-input (see tabManager.ts's doc
// comment on the function and window.ts's pushState).
describe("shouldFocusAddressBar", () => {
  const editorSnapshot: TabsSnapshot = {
    tabs: [{ id: 1, title: "Untitled", kind: "editor" }],
    activeId: 1,
    activeKind: "editor",
    activeTheme: null,
    mcpStatus: "off",
    mcpActiveWebContentsId: 1,
    agentTabIds: [],
  };

  const emptyBrowserSnapshot: TabsSnapshot = {
    tabs: [
      { id: 1, title: "Untitled", kind: "editor" },
      { id: 2, title: "New Tab", kind: "browser", url: "", canGoBack: false, canGoForward: false },
    ],
    activeId: 2,
    activeKind: "browser",
    activeTheme: null,
    mcpStatus: "off",
    mcpActiveWebContentsId: 1,
    agentTabIds: [],
  };

  it("is true on editor -> empty-URL browser tab activation", () => {
    expect(shouldFocusAddressBar(editorSnapshot, emptyBrowserSnapshot)).toBe(true);
  });

  it("is true even on the very first push, if it already lands on an empty browser tab", () => {
    expect(shouldFocusAddressBar(null, emptyBrowserSnapshot)).toBe(true);
  });

  it("is false on a repeat of the exact same state", () => {
    expect(shouldFocusAddressBar(emptyBrowserSnapshot, { ...emptyBrowserSnapshot })).toBe(false);
  });

  it("is false when the active browser tab already has a URL", () => {
    const alreadyNavigated: TabsSnapshot = {
      ...emptyBrowserSnapshot,
      tabs: [
        emptyBrowserSnapshot.tabs[0],
        { ...emptyBrowserSnapshot.tabs[1], url: "https://example.com" },
      ],
    };
    expect(shouldFocusAddressBar(editorSnapshot, alreadyNavigated)).toBe(false);
  });

  it("is false when activating an editor tab", () => {
    expect(shouldFocusAddressBar(emptyBrowserSnapshot, editorSnapshot)).toBe(false);
  });

  it("is false when only mcpStatus changed (same active tab)", () => {
    const mcpChanged: TabsSnapshot = { ...emptyBrowserSnapshot, mcpStatus: "listening" };
    expect(shouldFocusAddressBar(emptyBrowserSnapshot, mcpChanged)).toBe(false);
  });

  it("is false when only the active tab's title changed (same active tab)", () => {
    const titleChanged: TabsSnapshot = {
      ...emptyBrowserSnapshot,
      tabs: [
        emptyBrowserSnapshot.tabs[0],
        { ...emptyBrowserSnapshot.tabs[1], title: "Loading…" },
      ],
    };
    expect(shouldFocusAddressBar(emptyBrowserSnapshot, titleChanged)).toBe(false);
  });
});

describe("TabManager scopes (isolated browser sessions)", () => {
  let sessionsSeen: (string | undefined)[];
  let tm: TabManager;

  beforeEach(() => {
    sessionsSeen = [];
    let wc = 1;
    tm = new TabManager({
      createView: (_kind: TabKind, session?: string) => {
        sessionsSeen.push(session);
        const v = makeFakeView();
        v.getWebContentsId.mockReturnValue(wc++);
        return v;
      },
      editorUrl: "https://pen-editor.onrender.com",
      onStateChanged: () => {},
    });
    tm.newTab("editor");
  });

  it("passes the session to createView for browser tabs only", () => {
    tm.newTab("browser", "a");
    tm.newTab("browser");
    tm.newTab("editor", "a");
    expect(sessionsSeen).toEqual([undefined, "a", undefined, undefined]);
  });

  it("the shared browser never sees a session tab, and a session never sees the shared ones", () => {
    const shared = tm.newTab("browser");
    const a = tm.newTab("browser", "a");
    const b = tm.newTab("browser", "b");
    expect(tm.listBrowserTabs().map((t) => t.tabId)).toEqual([shared]);
    expect(tm.listBrowserTabs("a").map((t) => t.tabId)).toEqual([a]);
    expect(tm.listBrowserTabs("b").map((t) => t.tabId)).toEqual([b]);
    // b is the ACTIVE tab, yet the shared lookup still resolves its own tab.
    expect(tm.currentBrowserTabId()).toBe(shared);
    expect(tm.currentBrowserTabId("a")).toBe(a);
    expect(tm.browserHandle("a")).toBe(tm.browserTabHandleById(a, "a"));
    expect(tm.browserTabHandleById(a)).toBeNull();
    expect(tm.browserTabHandleById(shared, "a")).toBeNull();
  });

  it("a session tab opens in the background: no activation, hidden, active tab unchanged", () => {
    const editorId = tm.getSnapshot().activeId;
    const before = tm.count();
    const a = tm.newTab("browser", "a");
    expect(tm.count()).toBe(before + 1);
    expect(tm.getSnapshot().activeId).toBe(editorId);
    expect(tm.getSnapshot().activeKind).toBe("editor");
    // Clicking it makes it the active tab.
    tm.activate(a);
    expect(tm.getSnapshot().activeId).toBe(a);
  });

  it("closing the active tab never auto-activates a session tab when a normal neighbour exists", () => {
    const editor = tm.getSnapshot().activeId!;
    tm.newTab("browser", "a"); // background, right after the editor
    const shared = tm.newTab("browser"); // active
    tm.newTab("browser", "b");
    tm.closeTab(shared);
    expect(tm.getSnapshot().activeId).toBe(editor);
  });

  it("a shared browser tab still activates", () => {
    const b = tm.newTab("browser");
    expect(tm.getSnapshot().activeId).toBe(b);
  });

  it("an unknown session has no current tab", () => {
    tm.newTab("browser");
    expect(tm.currentBrowserTabId("nope")).toBeNull();
    expect(tm.browserHandle("nope")).toBeNull();
  });

  it("pins the agent tab per scope and ignores a pin that points into another scope", () => {
    const a1 = tm.newTab("browser", "a");
    const a2 = tm.newTab("browser", "a");
    const shared = tm.newTab("browser");
    tm.setAgentBrowserTabId(a1, "a");
    expect(tm.currentBrowserTabId("a")).toBe(a1);
    expect(tm.currentBrowserTabId()).toBe(shared);
    // A session id pinned as the SHARED agent tab does not resolve.
    tm.setAgentBrowserTabId(a2);
    expect(tm.currentBrowserTabId()).toBe(shared);
  });

  describe("revealAgentBrowserTab", () => {
    it("reveals the pinned shared tab and keeps the pin", () => {
      const b1 = tm.newTab("browser");
      const b2 = tm.newTab("browser"); // active
      tm.setAgentBrowserTabId(b1);
      expect(tm.revealAgentBrowserTab()).toBe(true);
      expect(tm.getSnapshot().activeId).toBe(b1);
      expect(tm.currentBrowserTabId()).toBe(b1);
      expect(b2).not.toBe(b1);
    });

    it("falls back to the default rule when nothing is pinned", () => {
      tm.newTab("browser");
      const b2 = tm.newTab("browser");
      tm.activate(tm.getSnapshot().tabs[0].id); // editor active
      expect(tm.revealAgentBrowserTab()).toBe(true);
      expect(tm.getSnapshot().activeId).toBe(b2);
    });

    it("reveals a session tab without repointing the shared pin", () => {
      const shared = tm.newTab("browser");
      const a = tm.newTab("browser", "a"); // background
      tm.setAgentBrowserTabId(shared);
      expect(tm.revealAgentBrowserTab("a")).toBe(true);
      expect(tm.getSnapshot().activeId).toBe(a);
      expect(tm.currentBrowserTabId()).toBe(shared);
      expect(tm.currentBrowserTabId("a")).toBe(a);
    });

    it("returns false and creates nothing when the scope has no browser tab", () => {
      tm.newTab("browser", "a");
      const before = tm.count();
      const active = tm.getSnapshot().activeId;
      expect(tm.revealAgentBrowserTab()).toBe(false);
      expect(tm.revealAgentBrowserTab("nope")).toBe(false);
      expect(tm.count()).toBe(before);
      expect(tm.getSnapshot().activeId).toBe(active);
      expect(sessionsSeen).toEqual([undefined, "a"]);
    });
  });

  it("a user click or cycle on a session tab does not repoint the session's agent tab", () => {
    const a1 = tm.newTab("browser", "a");
    const a2 = tm.newTab("browser", "a");
    const shared = tm.newTab("browser");
    tm.setAgentBrowserTabId(a2, "a");
    tm.setAgentBrowserTabId(shared);
    tm.activate(a1);
    expect(tm.currentBrowserTabId("a")).toBe(a2);
    expect(tm.currentBrowserTabId()).toBe(shared);
    tm.activate(shared);
    tm.nextTab();
    tm.nextTab();
    expect(tm.currentBrowserTabId("a")).toBe(a2);
  });

  it("closeSessionTabs closes only that session's tabs", () => {
    const shared = tm.newTab("browser");
    tm.newTab("browser", "a");
    tm.newTab("browser", "a");
    const b = tm.newTab("browser", "b");
    tm.closeSessionTabs("a");
    expect(tm.listBrowserTabs("a")).toEqual([]);
    expect(tm.listBrowserTabs().map((t) => t.tabId)).toEqual([shared]);
    expect(tm.listBrowserTabs("b").map((t) => t.tabId)).toEqual([b]);
  });

  it("closing a pinned session tab clears the pin", () => {
    const a1 = tm.newTab("browser", "a");
    const a2 = tm.newTab("browser", "a");
    tm.setAgentBrowserTabId(a1, "a");
    tm.closeTab(a1);
    expect(tm.currentBrowserTabId("a")).toBe(a2);
  });
});

describe("TabManager with zero tabs (closing the last tab leaves the window empty)", () => {
  const make = () => {
    const states: TabsSnapshot[] = [];
    let wc = 1;
    const tm = new TabManager({
      createView: () => {
        const v = makeFakeView();
        v.getWebContentsId.mockReturnValue(wc++);
        return v;
      },
      editorUrl: "https://x/app?chat=off",
      onStateChanged: (s) => states.push(s),
    });
    return { tm, states };
  };

  it("a fresh manager is safe with no tabs", () => {
    const { tm } = make();
    expect(tm.count()).toBe(0);
    const snap = tm.getSnapshot();
    expect(snap).toMatchObject({ tabs: [], activeId: null, activeKind: null, mcpActiveWebContentsId: null, agentTabIds: [] });
    expect(tm.activeHandle()).toBeNull();
    expect(tm.activeBrowserHandle()).toBeNull();
    expect(tm.editorTabsInfo()).toEqual({ tabs: [], activeWebContentsId: null });
    expect(() => {
      tm.nextTab();
      tm.prevTab();
      tm.layout({ x: 0, y: 0, width: 10, height: 10 });
      tm.closeTab(99);
      tm.activate(99);
      tm.destroyAll();
    }).not.toThrow();
  });

  it("closing the last tab leaves zero tabs and emits an empty snapshot", () => {
    const { tm, states } = make();
    const a = tm.newTab();
    tm.closeTab(a);
    expect(tm.count()).toBe(0);
    expect(states[states.length - 1]).toMatchObject({ tabs: [], activeId: null, activeKind: null, mcpActiveWebContentsId: null });
    // A tab can still be opened afterwards.
    const b = tm.newTab();
    expect(tm.getSnapshot().activeId).toBe(b);
  });

  it("closing the active tab with only background session tabs left leaves no active tab", () => {
    const { tm } = make();
    const a = tm.newTab();
    const s = tm.newTab("browser", "sess", { activate: false });
    tm.closeTab(a);
    expect(tm.count()).toBe(1);
    expect(tm.getSnapshot().activeId).toBeNull();
    expect(s).toBeGreaterThan(0);
  });

  it("a background-requested tab becomes active from the zero-tab state; later ones stay in the background", () => {
    const { tm } = make();
    const a = tm.newTab("editor", undefined, { activate: false });
    expect(tm.getSnapshot().activeId).toBe(a);
    const b = tm.newTab("editor", undefined, { activate: false });
    expect(tm.getSnapshot().activeId).toBe(a);
    expect(b).not.toBe(a);
  });

  it("a background-requested tab that only became active (zero tabs) does not take keyboard focus", () => {
    const views: ReturnType<typeof makeFakeView>[] = [];
    const tm = new TabManager({
      createView: () => {
        const v = makeFakeView();
        views.push(v);
        return v;
      },
      editorUrl: "u",
      onStateChanged: () => {},
    });
    const a = tm.newTab("editor", undefined, { activate: false });
    expect(tm.getSnapshot().activeId).toBe(a);
    expect(views[0].setVisible).toHaveBeenLastCalledWith(true);
    expect(views[0].focus).not.toHaveBeenCalled();
    // A default open (or an explicit activation) still focuses.
    tm.newTab();
    expect(views[1].focus).toHaveBeenCalledTimes(1);
    tm.activate(a);
    expect(views[0].focus).toHaveBeenCalledTimes(1);
  });

  it("decideActivationFocus: only an explicit activate:false skips focus", () => {
    expect(decideActivationFocus(false)).toBe(false);
    expect(decideActivationFocus(true)).toBe(true);
    expect(decideActivationFocus(undefined)).toBe(true);
  });

  it("an isolated session tab never becomes active, even from zero tabs", () => {
    const { tm } = make();
    tm.newTab("browser", "sess");
    expect(tm.getSnapshot().activeId).toBeNull();
  });
});
