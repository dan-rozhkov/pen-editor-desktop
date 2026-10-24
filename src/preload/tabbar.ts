import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { TabsSnapshot } from "../main/tabManager";
import type { UITheme } from "../main/tabManager";

const api = {
  isMac: process.platform === "darwin",
  newTab: () => ipcRenderer.send("tabbar:new"),
  /** Opens the native "+" popup (editor vs browser tab) anchored at window coordinates. */
  openNewTabMenu: (anchor: { x: number; y: number }) => ipcRenderer.send("tabbar:new-menu", anchor),
  /** Opens the native "Browser tools" popup (viewport / DevTools / zoom) anchored at window coordinates. */
  openToolsMenu: (anchor: { x: number; y: number }) => ipcRenderer.send("tabbar:tools-menu", anchor),
  /** Agent layout: show/hide the agent panel (the sidebar button). */
  togglePanel: () => ipcRenderer.send("tabbar:toggle-panel"),
  /** Right-click on a tab: opens the native tab menu (reveal file, close) at window coordinates. */
  openTabMenu: (id: number, anchor: { x: number; y: number }) => ipcRenderer.send("tabbar:tab-menu", { id, x: anchor.x, y: anchor.y }),
  activateTab: (id: number) => ipcRenderer.send("tabbar:activate", id),
  closeTab: (id: number) => ipcRenderer.send("tabbar:close", id),
  /** Drag-to-reorder: put tab `id` right before tab `beforeId` (null = at the end). */
  reorderTab: (id: number, beforeId: number | null) => ipcRenderer.send("tabbar:reorder", { id, beforeId }),
  navigate: (action: "url" | "back" | "forward" | "reload", url?: string) =>
    ipcRenderer.send("tabbar:navigate", { action, url }),
  onState: (cb: (s: TabsSnapshot) => void) => {
    ipcRenderer.on("tabbar:state", (_e: IpcRendererEvent, s: TabsSnapshot) => cb(s));
  },
  /** Page background colour for the address-row tail (null: keep the island colour). */
  onTail: (cb: (color: string | null) => void) => {
    ipcRenderer.on("tabbar:tail", (_e: IpcRendererEvent, color: string | null) => cb(color));
  },
  /** Per-frame strip offset (px) while the agent panel slides; the final value arrives on tabbar:state. */
  onStripLeft: (cb: (x: number) => void) => {
    ipcRenderer.on("tabbar:strip-left", (_e: IpcRendererEvent, x: number) => cb(x));
  },
  onTheme: (cb: (theme: UITheme) => void) => {
    ipcRenderer.on("tabbar:theme", (_e: IpcRendererEvent, theme: UITheme) => cb(theme));
  },
};

contextBridge.exposeInMainWorld("penTabbar", api);
