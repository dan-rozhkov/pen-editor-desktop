import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TabManager, resolveViewMode, type TabKind, type TabViewHandle, type ViewMode } from "../src/main/tabManager";
import { AGENT_AWAKE_HOLD_MS, KEEP_RENDERING_WHEN_OCCLUDED_SWITCH, createTabAgentActivity } from "../src/main/agentActivity";

function makeView(withViewMode: boolean) {
  const v = {
    loadURL: vi.fn(() => Promise.resolve()),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    destroy: vi.fn(),
    sendMenuCommand: vi.fn(),
    sendSettingsSection: vi.fn(),
    focus: vi.fn(),
    getWebContentsId: vi.fn(() => 0),
    onDocumentTitleChanged: vi.fn(),
    onThemeChanged: vi.fn(),
    onLoadingChanged: vi.fn(),
    onNavigationStateChanged: vi.fn(),
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
    ...(withViewMode ? { setViewMode: vi.fn() } : {}),
  };
  return v as unknown as TabViewHandle & {
    setVisible: ReturnType<typeof vi.fn>;
    setBounds: ReturnType<typeof vi.fn>;
    setViewMode: ReturnType<typeof vi.fn>;
  };
}

const AREA = { x: 1, y: 2, width: 300, height: 200 };

describe("resolveViewMode", () => {
  const none = new Set<number>();
  it("active tab is shown, even when awake", () => {
    expect(resolveViewMode({ id: 1, kind: "browser" }, 1, new Set([1]))).toBe("shown");
    expect(resolveViewMode({ id: 1, kind: "editor" }, 1, none)).toBe("shown");
  });
  it("an awake browser tab that is not active is awake", () => {
    expect(resolveViewMode({ id: 2, kind: "browser" }, 1, new Set([2]))).toBe("awake");
  });
  it("an editor tab in the awake set stays hidden", () => {
    expect(resolveViewMode({ id: 2, kind: "editor" }, 1, new Set([2]))).toBe("hidden");
  });
  it("everything else is hidden", () => {
    expect(resolveViewMode({ id: 2, kind: "browser" }, 1, none)).toBe("hidden");
    expect(resolveViewMode({ id: 2, kind: "browser" }, null, none)).toBe("hidden");
  });
});

describe("TabManager awake view modes", () => {
  let views: ReturnType<typeof makeView>[];
  let tm: TabManager;
  let withViewMode: boolean;

  const build = () => {
    views = [];
    tm = new TabManager({
      createView: (_k: TabKind) => {
        const v = makeView(withViewMode);
        views.push(v);
        return v;
      },
      editorUrl: "https://pen-editor.onrender.com",
      onStateChanged: () => {},
    });
  };
  const last = (v: ReturnType<typeof makeView>): ViewMode => v.setViewMode.mock.calls.at(-1)?.[0];

  beforeEach(() => {
    withViewMode = true;
    build();
  });

  it("without awake tabs: active is shown, the others hidden", () => {
    tm.newTab("editor");
    tm.newTab("browser");
    expect(last(views[0])).toBe("hidden");
    expect(last(views[1])).toBe("shown");
    expect(views.flatMap((v) => v.setViewMode.mock.calls.map((c) => c[0])).includes("awake")).toBe(false);
  });

  it("an awake browser tab under the canvas tab is awake; activating it shows it; leaving makes it awake again", () => {
    const canvas = tm.newTab("editor");
    const b = tm.newTab("browser", undefined, { activate: false });
    tm.setAgentTabAwake(b, true);
    expect(last(views[0])).toBe("shown");
    expect(last(views[1])).toBe("awake");
    tm.activate(b);
    expect(last(views[1])).toBe("shown");
    expect(last(views[0])).toBe("hidden");
    tm.activate(canvas);
    expect(last(views[1])).toBe("awake");
  });

  it("clearing awake hides the tab again", () => {
    tm.newTab("editor");
    const b = tm.newTab("browser", undefined, { activate: false });
    tm.setAgentTabAwake(b, true);
    tm.setAgentTabAwake(b, false);
    expect(last(views[1])).toBe("hidden");
  });

  it("a session tab opened in the background and marked awake is awake", () => {
    tm.newTab("editor");
    const s = tm.newTab("browser", "a");
    expect(last(views[1])).toBe("hidden");
    tm.setAgentTabAwake(s, true);
    expect(last(views[1])).toBe("awake");
    expect(tm.getSnapshot().activeKind).toBe("editor");
  });

  it("an unchanged awake flag is a no-op and emits no snapshot", () => {
    const states: unknown[] = [];
    tm = new TabManager({ createView: () => makeView(true), editorUrl: "x", onStateChanged: (s) => states.push(s) });
    tm.newTab("editor");
    const b = tm.newTab("browser", undefined, { activate: false });
    const n = states.length;
    tm.setAgentTabAwake(b, true);
    tm.setAgentTabAwake(b, true);
    expect(states.length).toBe(n);
  });

  it("closing an awake tab forgets it", () => {
    tm.newTab("editor");
    const b = tm.newTab("browser", undefined, { activate: false });
    tm.setAgentTabAwake(b, true);
    expect(tm.hasAwakeTab()).toBe(true);
    tm.closeTab(b);
    expect(tm.hasAwakeTab()).toBe(false);
  });

  it("a handle without setViewMode keeps an awake tab hidden (it cannot go under the active tab)", () => {
    withViewMode = false;
    build();
    tm.newTab("editor");
    const b = tm.newTab("browser", undefined, { activate: false });
    expect(views[0].setVisible).toHaveBeenLastCalledWith(true);
    expect(views[1].setVisible).toHaveBeenLastCalledWith(false);
    tm.setAgentTabAwake(b, true);
    expect(views[1].setVisible).not.toHaveBeenLastCalledWith(true);
    expect(views[0].setVisible).toHaveBeenLastCalledWith(true);
    tm.activate(b);
    expect(views[1].setVisible).toHaveBeenLastCalledWith(true);
  });

  it("setAgentTabAwake touches only that tab's view", () => {
    tm.newTab("editor");
    const b = tm.newTab("browser", undefined, { activate: false });
    const c = tm.newTab("browser", undefined, { activate: false });
    for (const v of views) v.setViewMode?.mockClear();
    tm.setAgentTabAwake(b, true);
    expect(views[1].setViewMode).toHaveBeenCalledWith("awake");
    expect(views[0].setViewMode).not.toHaveBeenCalled();
    expect(views[2].setViewMode).not.toHaveBeenCalled();
    expect(c).toBeGreaterThan(b);
  });

  it("layoutActive moves the active tab and awake tabs, not hidden ones", () => {
    tm.newTab("editor");
    const b = tm.newTab("browser", undefined, { activate: false });
    tm.newTab("browser", undefined, { activate: false });
    tm.setAgentTabAwake(b, true);
    for (const v of views) v.setBounds.mockClear();
    tm.layoutActive(AREA);
    expect(views[0].setBounds).toHaveBeenCalledWith(AREA);
    expect(views[1].setBounds).toHaveBeenCalledWith(AREA);
    expect(views[2].setBounds).not.toHaveBeenCalled();
  });
});

describe("awake hold", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds for 60 s after the last end", () => {
    expect(AGENT_AWAKE_HOLD_MS).toBe(60_000);
    const onChange = vi.fn<(id: number, awake: boolean) => void>();
    const a = createTabAgentActivity({ idleMs: AGENT_AWAKE_HOLD_MS, onChange });
    a.begin(7);
    a.end(7);
    vi.advanceTimersByTime(59_999);
    expect(onChange).toHaveBeenLastCalledWith(7, true);
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenLastCalledWith(7, false);
  });
});

describe("occlusion switch", () => {
  it("is the Chromium switch name", () => {
    expect(KEEP_RENDERING_WHEN_OCCLUDED_SWITCH).toBe("disable-backgrounding-occluded-windows");
  });
});
