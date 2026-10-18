import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { UITheme } from "../main/tabManager";

// Minimal bridge of the empty-state view (agent layout, zero tabs): it can only
// ask for a new tab and hear the theme. Nothing else of the tab bar API.
const api = {
  newCanvasTab: () => ipcRenderer.send("tabbar:new"),
  newBrowserTab: () => ipcRenderer.send("tabbar:new-browser"),
  onTheme: (cb: (theme: UITheme) => void) => {
    ipcRenderer.on("tabbar:theme", (_e: IpcRendererEvent, theme: UITheme) => cb(theme));
  },
};

contextBridge.exposeInMainWorld("penEmpty", api);
