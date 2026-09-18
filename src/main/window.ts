import path from "node:path";
import { BaseWindow, WebContentsView, Menu, ipcMain, nativeTheme, shell } from "electron";
import {
  TabManager,
  shouldFocusAddressBar,
  type TabKind,
  type TabViewHandle,
  type TabsSnapshot,
  type UITheme,
} from "./tabManager";
import { buildMenuTemplate } from "./menu";
import {
  attachNavigationPolicy,
  attachOfflineFallback,
  attachLocalOnlyPolicy,
  attachBrowserTabPolicy,
  decideBrowserNavigation,
  shouldDropMcpRegistration,
} from "./navigation";
import { BrowserController, type BrowserTarget, type BrowserPageHandle } from "./browser/controller";
import type { McpService, IpcListenerGateway } from "./mcp/service";

export const TABBAR_HEIGHT = 38;
// The address row (design doc `2026-09-18-builtin-browser-design.md` §2) —
// rendered as a second row inside the existing tab-bar view, shown only
// when the active tab is a browser tab.
export const CHROME_HEIGHT = 32;

// Real ipcMain wiring for McpService.registerAppLevelIpc — kept here (not in
// service.ts, which stays Electron-free for testability, see its header
// comment) with the channel names written as literals so
// test/ipcContract.test.ts's mechanical source scan can find them, exactly
// like the existing tabbar ipcMain.on("tabbar:new", ...) calls below.
function createMcpIpcGateway(): IpcListenerGateway {
  const wrapped = new Map<(senderId: number, payload: unknown) => void, (event: Electron.IpcMainEvent, payload: unknown) => void>();
  return {
    on(channel, listener) {
      const w = (event: Electron.IpcMainEvent, payload: unknown) => listener(event.sender.id, payload);
      wrapped.set(listener, w);
      if (channel === "mcp:register") ipcMain.on("mcp:register", w);
      else ipcMain.on("mcp:result", w);
    },
    removeListener(channel, listener) {
      const w = wrapped.get(listener);
      if (!w) return;
      wrapped.delete(listener);
      if (channel === "mcp:register") ipcMain.removeListener("mcp:register", w);
      else ipcMain.removeListener("mcp:result", w);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One app window: a tab-bar WebContentsView on top, one WebContentsView per
 * editor tab below. All policy/tab logic lives in tabManager/menu/navigation;
 * this file only wires Electron objects together.
 *
 * `mcpService` is app-scoped (see mcp/service.ts's header) — created once in
 * index.ts and passed in here, not created per window, since a macOS window
 * close/reopen must not tear down or duplicate the MCP HTTP server or its
 * ipcMain listeners. This function only *reports* tab create/destroy/active
 * and the app-level MCP menu status into it.
 */
export function createMainWindow(editorUrl: string, mcpService: McpService): BaseWindow {
  // Idempotent — see registerAppLevelIpc's own doc comment. Safe to call on
  // every window (re)creation, including the macOS dock "activate" reopen.
  mcpService.registerAppLevelIpc(createMcpIpcGateway());
  const editorOrigin = new URL(editorUrl).origin;
  const offlineFile = path.join(__dirname, "../assets/offline.html");

  const win = new BaseWindow({
    width: 1440,
    height: 900,
    title: "Pineapple Editor",
    // Put the tab strip in the native title-bar row on macOS while keeping
    // the standard traffic-light controls. Other platforms retain their
    // normal system frame.
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
  });

  // --- tab bar view ---
  const tabbarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "../preload/tabbar.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.contentView.addChildView(tabbarView);
  attachLocalOnlyPolicy(tabbarView.webContents);
  void tabbarView.webContents.loadFile(path.join(__dirname, "../tabbar/tabbar.html"));

  const systemTheme = (): UITheme => (nativeTheme.shouldUseDarkColors ? "dark" : "light");
  // The last snapshot actually pushed — kept only so shouldFocusAddressBar
  // (tabManager.ts) has a "previous" to compare against. window.ts owns
  // this bit of bookkeeping so the pure predicate itself stays stateless;
  // it does not make the focus decision, only feeds and acts on it.
  let previousSnapshot: TabsSnapshot | null = null;
  const pushState = (s: TabsSnapshot) => {
    // s.mcpActiveWebContentsId is computed by TabManager itself (see
    // TabsSnapshot's doc comment / finding 1) — window.ts just forwards it,
    // rather than tracking "last editor tab" locally, since only TabManager
    // sees a tab's destruction in time to repoint away from a dying editor
    // tab before this snapshot goes out.
    mcpService.setActiveTab(s.mcpActiveWebContentsId);
    // A fresh, empty-URL browser tab (File ▸ New Browser Tab, or switching
    // to one that was never navigated) becoming active must put the caret
    // in the address bar, the way every real browser does on a new tab —
    // otherwise the tab is a void with no cue where to type (its content
    // area loads nothing on purpose; the input's placeholder is the only
    // explanation, and it only helps once focused). Two halves, both
    // required: focusing `tabbarView`'s own WebContentsView here (OS-level
    // — the tab bar is its own view, so focusing an input inside its DOM
    // from the renderer alone would not move where keystrokes actually go),
    // and the renderer itself focusing/selecting `#url-input` once it sees
    // `focusAddressBar` on the pushed snapshot (src/tabbar/renderer.ts).
    // shouldFocusAddressBar is deliberately keyed off "the active tab
    // changed since the previous push" so this never fires on the title/
    // navigation-state/MCP-status/resize-driven pushes that also flow
    // through here — those must never yank focus away from whatever the
    // user is doing.
    const focusAddressBar = shouldFocusAddressBar(previousSnapshot, s);
    previousSnapshot = s;
    tabbarView.webContents.send("tabbar:state", { ...s, focusAddressBar });
    tabbarView.webContents.send("tabbar:theme", s.activeTheme ?? systemTheme());
    if (focusAddressBar) tabbarView.webContents.focus();
    // The active tab's kind can change (activating a browser tab, or an
    // editor tab) without a window resize — re-run layout every time the
    // snapshot changes so the address row's height tracks activeKind
    // (design doc §2). `layout` is defined below `tabs`, but this closure is
    // never invoked until TabManager itself calls onStateChanged, which
    // happens no earlier than the first tabs.newTab() call at the bottom of
    // this function — by then `layout` is already assigned.
    layout();
  };
  // tabs.setMcpStatus() (below) folds the current MCP status into every
  // TabsSnapshot pushState already sends — the tab strip's indicator reuses
  // the existing tabbar:state channel rather than adding a fourth one (see
  // CLAUDE.md's IPC section and mcp/service.ts's McpService.getStatus()).

  const themeCallbacks = new Map<number, (theme: UITheme) => void>();
  const titleCallbacks = new Map<number, (title: string) => void>();
  const onEditorTheme = (event: Electron.IpcMainEvent, theme: unknown) => {
    if (theme !== "light" && theme !== "dark") return;
    themeCallbacks.get(event.sender.id)?.(theme);
  };
  ipcMain.on("editor:theme", onEditorTheme);
  const onEditorDocumentTitle = (event: Electron.IpcMainEvent, title: unknown) => {
    if (typeof title !== "string") return;
    const normalized = title.trim().slice(0, 200) || "Untitled";
    titleCallbacks.get(event.sender.id)?.(normalized);
    // Feeds list_editor_tabs (mcp/service.ts) — keyed by the same
    // webContents id as everything else in the MCP tab registry, so it
    // never needs a separate id-translation step the way pushState above
    // does for TabManager's own sequential ids.
    mcpService.setTabTitle(event.sender.id, normalized);
  };
  ipcMain.on("editor:document-title", onEditorDocumentTitle);

  // --- tabs ---
  const tabs = new TabManager({
    editorUrl,
    onStateChanged: pushState,
    createView: (kind: TabKind): TabViewHandle => {
      const view = new WebContentsView(
        kind === "browser"
          ? {
              webPreferences: {
                // Dedicated session partition — the security boundary for
                // the built-in browser (design doc §1): the editor's
                // cookies are never in it, and whatever the user logs into
                // here is all the agent can ever reach. Deliberately no
                // preload: a browser tab must never see `penDesktop`.
                partition: "persist:penbrowser",
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
              },
            }
          : {
              webPreferences: {
                preload: path.join(__dirname, "../preload/tab.js"),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
              },
            },
      );
      win.contentView.addChildView(view);
      const viewId = view.webContents.id;

      if (kind === "editor") {
        attachNavigationPolicy(view.webContents, editorOrigin, (url) => void shell.openExternal(url));
        attachOfflineFallback(view.webContents, offlineFile);
        mcpService.registerTab(viewId, {
          sendMcpCall: (callId, tool, args) => view.webContents.send("mcp:call", { callId, tool, args }),
          isDestroyed: () => view.webContents.isDestroyed(),
        });
        // A tab's page reload drops whatever registerMcpBridge() call the
        // previous page made — the new page has to re-register (design doc
        // §2/§3). Only the main frame counts: an iframe navigating inside the
        // editor page is not the editor tab itself going away. `isSameDocument`
        // must also be excluded: Electron fires did-start-navigation for
        // pushState/replaceState/hash navigation too (same-document, main
        // frame), and pen-editor is a react-router SPA — an in-app link click
        // would otherwise be treated as a full page reload, dropping the
        // registration even though registerMcpBridge() was never re-run (its
        // module-scoped `teardown` guard makes initDesktopMcpBridge() a no-op
        // on the next call), permanently killing the bridge until a manual
        // reload.
        view.webContents.on("did-start-navigation", (details) => {
          if (shouldDropMcpRegistration(details)) mcpService.handleTabNavigated(viewId);
        });
      } else {
        // Browser tabs: never registered with the MCP bridge, never get the
        // editor:* IPC callbacks (there is no preload to send them from
        // anyway). Popups open as a new browser tab instead of escaping to
        // the system browser.
        attachBrowserTabPolicy(view.webContents, (url) => {
          tabs.newTab("browser");
          tabs
            .activeHandle()
            ?.loadURL(url)
            .catch((err) => console.error("browser tab: popup navigation failed", err));
        });
      }

      let navListener: ((s: { url: string; title: string; canGoBack: boolean; canGoForward: boolean }) => void) | null =
        null;
      const reportNavState = () => {
        if (!navListener) return;
        navListener({
          url: view.webContents.getURL(),
          title: view.webContents.getTitle(),
          canGoBack: view.webContents.navigationHistory.canGoBack(),
          canGoForward: view.webContents.navigationHistory.canGoForward(),
        });
      };
      view.webContents.on("did-navigate", reportNavState);
      view.webContents.on("did-navigate-in-page", reportNavState);
      view.webContents.on("page-title-updated", reportNavState);

      return {
        loadURL: (url) => view.webContents.loadURL(url),
        setBounds: (b) => view.setBounds(b),
        setVisible: (v) => view.setVisible(v),
        destroy: () => {
          themeCallbacks.delete(viewId);
          titleCallbacks.delete(viewId);
          if (kind === "editor") mcpService.unregisterTab(viewId);
          win.contentView.removeChildView(view);
          view.webContents.close();
        },
        sendMenuCommand: (id) => view.webContents.send("menu:command", id),
        focus: () => view.webContents.focus(),
        onDocumentTitleChanged: (cb) => titleCallbacks.set(viewId, cb),
        onThemeChanged: (cb) => themeCallbacks.set(viewId, cb),
        getWebContentsId: () => viewId,
        onNavigationStateChanged: (cb) => {
          navListener = cb;
        },
        getURL: () => view.webContents.getURL(),
        getTitle: () => view.webContents.getTitle(),
        goBack: () => view.webContents.navigationHistory.goBack(),
        goForward: () => view.webContents.navigationHistory.goForward(),
        reload: () => view.webContents.reload(),
        canGoBack: () => view.webContents.navigationHistory.canGoBack(),
        canGoForward: () => view.webContents.navigationHistory.canGoForward(),
        executeJavaScript: (code) => view.webContents.executeJavaScript(code),
        isLoading: () => view.webContents.isLoading(),
        onceDomReady: () =>
          new Promise<void>((resolve) => {
            view.webContents.once("dom-ready", () => resolve());
          }),
      };
    },
  });

  // --- built-in browser (design doc §3/§4) ---
  const browserTarget: BrowserTarget = {
    ensurePage: async (): Promise<BrowserPageHandle> => {
      const existing = tabs.browserHandle();
      if (existing) return existing;
      tabs.newTab("browser");
      const created = tabs.browserHandle();
      if (!created) throw new Error("Failed to create a browser tab.");
      return created;
    },
    currentPage: (): BrowserPageHandle | null => tabs.browserHandle(),
  };
  const browserController = new BrowserController(browserTarget);

  const onBrowserCommand = (event: Electron.IpcMainInvokeEvent, payload: unknown) => {
    // Single source of truth for "which webContents id is an editor tab" —
    // TabManager.isEditorTab (finding 10). Deliberately not a second,
    // window.ts-local registry: two independent lists of the same fact can
    // drift, and TabManager's is already kept correct by newTab/destroy.
    if (!tabs.isEditorTab(event.sender.id)) return { error: "Not allowed." };
    if (!isRecord(payload) || typeof payload.command !== "string") {
      return { error: "Malformed browser command." };
    }
    switch (payload.command) {
      case "open":
        return browserController.open(payload.args);
      case "act":
        return browserController.act(payload.args);
      case "findImages":
        return browserController.findImages(payload.args);
      case "snapshot":
        return browserController.snapshot();
      case "perform":
        return browserController.perform(payload.args);
      case "read":
        return browserController.read(payload.args);
      default:
        return { error: `Unknown browser command: ${payload.command}` };
    }
  };
  ipcMain.handle("browser:command", onBrowserCommand);

  // --- layout ---
  const layout = () => {
    const { width, height } = win.getContentBounds();
    const activeKind = tabs.getSnapshot().activeKind;
    const tabbarHeight = TABBAR_HEIGHT + (activeKind === "browser" ? CHROME_HEIGHT : 0);
    tabbarView.setBounds({ x: 0, y: 0, width, height: tabbarHeight });
    tabs.layout({ width, height }, tabbarHeight);
  };
  win.on("resize", layout);
  layout();

  // --- tab bar IPC (scoped to this window's tabbar webContents) ---
  const tabbarId = tabbarView.webContents.id;
  const fromOurTabbar = (event: Electron.IpcMainEvent) => event.sender.id === tabbarId;
  const onTabbarNew = (e: Electron.IpcMainEvent) => fromOurTabbar(e) && tabs.newTab("editor");
  const onTabbarActivate = (e: Electron.IpcMainEvent, id: number) =>
    fromOurTabbar(e) && tabs.activate(id);
  const onTabbarClose = (e: Electron.IpcMainEvent, id: number) =>
    fromOurTabbar(e) && tabs.closeTab(id);
  const onTabbarNavigate = (e: Electron.IpcMainEvent, payload: unknown) => {
    if (!fromOurTabbar(e)) return;
    if (!isRecord(payload)) return;
    const action = payload.action;
    const handle = tabs.browserHandle();
    if (!handle) return;
    if (action === "back") handle.goBack();
    else if (action === "forward") handle.goForward();
    else if (action === "reload") handle.reload();
    else if (action === "url" && typeof payload.url === "string") {
      if (decideBrowserNavigation(payload.url) !== "allow") return;
      void handle.loadURL(payload.url).catch(() => {});
    }
  };
  ipcMain.on("tabbar:new", onTabbarNew);
  ipcMain.on("tabbar:activate", onTabbarActivate);
  ipcMain.on("tabbar:close", onTabbarClose);
  ipcMain.on("tabbar:navigate", onTabbarNavigate);
  // Re-send current state when the tab bar (re)loads — it may have missed
  // snapshots emitted before its DOM was ready.
  tabbarView.webContents.on("did-finish-load", () => pushState(tabs.getSnapshot()));
  const onSystemThemeChanged = () => {
    if (tabs.getSnapshot().activeTheme === null) pushState(tabs.getSnapshot());
  };
  nativeTheme.on("updated", onSystemThemeChanged);

  // --- teardown ---
  // BaseWindow instances (and everything they capture — TabManager, the tab
  // views, the tabbar view) outlive a window close on macOS, since index.ts
  // recreates a window on dock "activate" without quitting the app. Without
  // this, every close/reopen cycle leaks the ipcMain listeners above plus
  // every tab's WebContentsView (renderer process stays alive).
  win.on("closed", () => {
    ipcMain.removeListener("tabbar:new", onTabbarNew);
    ipcMain.removeListener("tabbar:activate", onTabbarActivate);
    ipcMain.removeListener("tabbar:close", onTabbarClose);
    ipcMain.removeListener("tabbar:navigate", onTabbarNavigate);
    ipcMain.removeListener("editor:theme", onEditorTheme);
    ipcMain.removeListener("editor:document-title", onEditorDocumentTitle);
    ipcMain.removeHandler("browser:command");
    nativeTheme.removeListener("updated", onSystemThemeChanged);
    unsubscribeMcpStatus();
    tabs.destroyAll();
    tabbarView.webContents.close();
  });

  // --- menu ---
  // Rebuilt (not just mutated) whenever MCP status changes: a native menu
  // template has no live-binding mechanism, and Menu.setApplicationMenu is
  // process-global (the wart CLAUDE.md already documents for this menu) —
  // fine for the current single-window app, revisit if multi-window support
  // is ever added.
  const rebuildMenu = () => {
    const menu = Menu.buildFromTemplate(
      buildMenuTemplate(
        {
          newTab: () => tabs.newTab("editor"),
          newBrowserTab: () => tabs.newTab("browser"),
          closeTab: () => {
            const active = tabs.getSnapshot().activeId;
            if (active !== null) tabs.closeTab(active);
          },
          nextTab: () => tabs.nextTab(),
          prevTab: () => tabs.prevTab(),
          forwardToActiveTab: (commandId) => tabs.activeHandle()?.sendMenuCommand(commandId),
          useThisAppForMcp: () => void mcpService.forcePublish(),
        },
        { isMac: process.platform === "darwin" },
        mcpService.getStatus(),
      ),
    );
    Menu.setApplicationMenu(menu);
  };
  rebuildMenu();
  tabs.setMcpStatus(mcpService.getStatus());
  const unsubscribeMcpStatus = mcpService.onStatusChanged(() => {
    tabs.setMcpStatus(mcpService.getStatus());
    rebuildMenu();
  });

  tabs.newTab("editor");
  return win;
}
