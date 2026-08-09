import path from "node:path";
import { BaseWindow, WebContentsView, Menu, ipcMain, nativeTheme, shell } from "electron";
import {
  TabManager,
  type TabViewHandle,
  type TabsSnapshot,
  type UITheme,
} from "./tabManager";
import { buildMenuTemplate } from "./menu";
import {
  attachNavigationPolicy,
  attachOfflineFallback,
  attachLocalOnlyPolicy,
  shouldDropMcpRegistration,
} from "./navigation";
import type { McpService, IpcListenerGateway } from "./mcp/service";

export const TABBAR_HEIGHT = 38;

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
  const pushState = (s: TabsSnapshot) => {
    // s.activeId is TabManager's own sequential tab id — a different id
    // space from the webContents id mcp/service.ts's tab registry is keyed
    // by (registerTab/handleRegister/handleResult all key off
    // event.sender.id / webContents.id). Translate via the active view's
    // handle rather than passing s.activeId straight through, or every real
    // tools/call would 404 against a tab that was never registered under
    // that id — see TabViewHandle.getWebContentsId's doc comment.
    mcpService.setActiveTab(tabs.activeHandle()?.getWebContentsId() ?? null);
    tabbarView.webContents.send("tabbar:state", s);
    tabbarView.webContents.send("tabbar:theme", s.activeTheme ?? systemTheme());
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
    createView: (): TabViewHandle => {
      const view = new WebContentsView({
        webPreferences: {
          preload: path.join(__dirname, "../preload/tab.js"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      attachNavigationPolicy(view.webContents, editorOrigin, (url) => void shell.openExternal(url));
      attachOfflineFallback(view.webContents, offlineFile);
      win.contentView.addChildView(view);
      const viewId = view.webContents.id;
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
      return {
        loadURL: (url) => void view.webContents.loadURL(url),
        setBounds: (b) => view.setBounds(b),
        setVisible: (v) => view.setVisible(v),
        destroy: () => {
          themeCallbacks.delete(viewId);
          titleCallbacks.delete(viewId);
          mcpService.unregisterTab(viewId);
          win.contentView.removeChildView(view);
          view.webContents.close();
        },
        sendMenuCommand: (id) => view.webContents.send("menu:command", id),
        focus: () => view.webContents.focus(),
        onDocumentTitleChanged: (cb) => titleCallbacks.set(viewId, cb),
        onThemeChanged: (cb) => themeCallbacks.set(viewId, cb),
        getWebContentsId: () => viewId,
      };
    },
  });

  // --- layout ---
  const layout = () => {
    const { width, height } = win.getContentBounds();
    tabbarView.setBounds({ x: 0, y: 0, width, height: TABBAR_HEIGHT });
    tabs.layout({ width, height }, TABBAR_HEIGHT);
  };
  win.on("resize", layout);
  layout();

  // --- tab bar IPC (scoped to this window's tabbar webContents) ---
  const tabbarId = tabbarView.webContents.id;
  const fromOurTabbar = (event: Electron.IpcMainEvent) => event.sender.id === tabbarId;
  const onTabbarNew = (e: Electron.IpcMainEvent) => fromOurTabbar(e) && tabs.newTab();
  const onTabbarActivate = (e: Electron.IpcMainEvent, id: number) =>
    fromOurTabbar(e) && tabs.activate(id);
  const onTabbarClose = (e: Electron.IpcMainEvent, id: number) =>
    fromOurTabbar(e) && tabs.closeTab(id);
  ipcMain.on("tabbar:new", onTabbarNew);
  ipcMain.on("tabbar:activate", onTabbarActivate);
  ipcMain.on("tabbar:close", onTabbarClose);
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
    ipcMain.removeListener("editor:theme", onEditorTheme);
    ipcMain.removeListener("editor:document-title", onEditorDocumentTitle);
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
          newTab: () => tabs.newTab(),
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

  tabs.newTab();
  return win;
}
