import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { TabsSnapshot } from "../main/tabManager";
import type { UITheme } from "../main/tabManager";

const api = {
  newTab: () => ipcRenderer.send("tabbar:new"),
  activateTab: (id: number) => ipcRenderer.send("tabbar:activate", id),
  closeTab: (id: number) => ipcRenderer.send("tabbar:close", id),
  onState: (cb: (s: TabsSnapshot) => void) => {
    ipcRenderer.on("tabbar:state", (_e: IpcRendererEvent, s: TabsSnapshot) => cb(s));
  },
  onTheme: (cb: (theme: UITheme) => void) => {
    ipcRenderer.on("tabbar:theme", (_e: IpcRendererEvent, theme: UITheme) => cb(theme));
  },
};

contextBridge.exposeInMainWorld("penTabbar", api);
