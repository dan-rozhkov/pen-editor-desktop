import path from "node:path";
import { BaseWindow, WebContentsView, Menu, ipcMain, shell } from "electron";
import { TabManager, type TabViewHandle, type TabsSnapshot } from "./tabManager";
import { buildMenuTemplate } from "./menu";
import { attachNavigationPolicy, attachOfflineFallback, attachLocalOnlyPolicy } from "./navigation";

export const TABBAR_HEIGHT = 38;

/**
 * One app window: a tab-bar WebContentsView on top, one WebContentsView per
 * editor tab below. All policy/tab logic lives in tabManager/menu/navigation;
 * this file only wires Electron objects together.
 */
export function createMainWindow(editorUrl: string): BaseWindow {
  const editorOrigin = new URL(editorUrl).origin;
  const offlineFile = path.join(__dirname, "../assets/offline.html");

  const win = new BaseWindow({ width: 1440, height: 900, title: "Pen Editor" });

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

  const pushState = (s: TabsSnapshot) => tabbarView.webContents.send("tabbar:state", s);

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
      return {
        loadURL: (url) => void view.webContents.loadURL(url),
        setBounds: (b) => view.setBounds(b),
        setVisible: (v) => view.setVisible(v),
        destroy: () => {
          win.contentView.removeChildView(view);
          view.webContents.close();
        },
        sendMenuCommand: (id) => view.webContents.send("menu:command", id),
        focus: () => view.webContents.focus(),
        onTitleChanged: (cb) =>
          view.webContents.on("page-title-updated", (_e, title) => cb(title)),
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
    tabs.destroyAll();
    tabbarView.webContents.close();
  });

  // --- menu ---
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
      },
      { isMac: process.platform === "darwin" },
    ),
  );
  // The application menu is process-global (Menu.setApplicationMenu), but
  // its handlers close over this window's TabManager. Fine for the current
  // single-window app; revisit if multi-window support is ever added.
  Menu.setApplicationMenu(menu);

  tabs.newTab();
  return win;
}
