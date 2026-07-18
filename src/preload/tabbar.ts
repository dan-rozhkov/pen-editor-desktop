import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { TabsSnapshot } from "../main/tabManager";

const api = {
  newTab: () => ipcRenderer.send("tabbar:new"),
  activateTab: (id: number) => ipcRenderer.send("tabbar:activate", id),
  closeTab: (id: number) => ipcRenderer.send("tabbar:close", id),
  onState: (cb: (s: TabsSnapshot) => void) => {
    ipcRenderer.on("tabbar:state", (_e: IpcRendererEvent, s: TabsSnapshot) => cb(s));
  },
};

contextBridge.exposeInMainWorld("penTabbar", api);
