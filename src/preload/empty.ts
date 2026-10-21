import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { UITheme } from "../main/tabManager";

// Minimal bridge of the empty-state view (agent layout, zero tabs): it can only
// ask for a new tab and hear its state (theme, background session tab count). Nothing else of the tab bar API.
interface EmptyState {
  theme: UITheme;
  /** Background isolated-session tabs still open (the page shows a note when above 0). */
  sessionTabs: number;
}

const api = {
  newCanvasTab: () => ipcRenderer.send("tabbar:new"),
  newBrowserTab: () => ipcRenderer.send("tabbar:new-browser"),
  newDocTab: () => ipcRenderer.send("tabbar:new-doc"),
  newWorkflowTab: () => ipcRenderer.send("tabbar:new-workflow"),
  onState: (cb: (state: EmptyState) => void) => {
    ipcRenderer.on("tabbar:theme", (_e: IpcRendererEvent, state: EmptyState) => cb(state));
  },
};

contextBridge.exposeInMainWorld("penEmpty", api);
