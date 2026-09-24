import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { TabsSnapshot } from "../main/tabManager";
import type { UITheme } from "../main/tabManager";

const api = {
  isMac: process.platform === "darwin",
  newTab: () => ipcRenderer.send("tabbar:new"),
  /** Opens the native "+" popup (editor vs browser tab) anchored at window coordinates. */
  openNewTabMenu: (anchor: { x: number; y: number }) => ipcRenderer.send("tabbar:new-menu", anchor),
  activateTab: (id: number) => ipcRenderer.send("tabbar:activate", id),
  closeTab: (id: number) => ipcRenderer.send("tabbar:close", id),
  navigate: (action: "url" | "back" | "forward" | "reload", url?: string) =>
    ipcRenderer.send("tabbar:navigate", { action, url }),
  onState: (cb: (s: TabsSnapshot) => void) => {
    ipcRenderer.on("tabbar:state", (_e: IpcRendererEvent, s: TabsSnapshot) => cb(s));
  },
  onTheme: (cb: (theme: UITheme) => void) => {
    ipcRenderer.on("tabbar:theme", (_e: IpcRendererEvent, theme: UITheme) => cb(theme));
  },
};

contextBridge.exposeInMainWorld("penTabbar", api);
