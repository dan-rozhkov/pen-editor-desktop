import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { UITheme } from "../main/tabManager";

// Minimal bridge of the empty-state view (agent layout, zero tabs): it can only
// ask for a new tab and hear its state (theme, background session tab count). Nothing else of the tab bar API.
/** One row of the Recent list (src/main/recentItems.ts). */
interface RecentItem {
  kind: "canvas" | "doc";
  id: string;
  title: string;
  updatedAt: number;
}

interface EmptyState {
  theme: UITheme;
  /** Background isolated-session tabs still open (the page shows a note when above 0). */
  sessionTabs: number;
}

const api = {
  newCanvasTab: () => ipcRenderer.send("tabbar:new"),
  newBrowserTab: () => ipcRenderer.send("tabbar:new-browser"),
  newDocTab: () => ipcRenderer.send("tabbar:new-doc"),
  listRecent: async (): Promise<RecentItem[]> => {
    const result: unknown = await ipcRenderer.invoke("empty:recent");
    const items = (result as { items?: unknown } | null)?.items;
    return Array.isArray(items) ? (items as RecentItem[]) : [];
  },
  openItem: (kind: "canvas" | "doc", id: string) => ipcRenderer.send("empty:open", { kind, id }),
  /** Main says a document or canvas was stored or deleted: the Recent list may be out of date. */
  onRecentChanged: (cb: () => void) => {
    ipcRenderer.on("empty:recent-changed", () => cb());
  },
  onState: (cb: (state: EmptyState) => void) => {
    ipcRenderer.on("tabbar:theme", (_e: IpcRendererEvent, state: EmptyState) => cb(state));
  },
};

contextBridge.exposeInMainWorld("penEmpty", api);
