import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { UITheme } from "../main/tabManager";

// Minimal bridge of the empty-state view (agent layout, zero tabs): it can only
// ask for a new tab and hear its state (theme, background session tab count). Nothing else of the tab bar API.
/** Answer of `empty:delete` (see EmptyDeleteResult in src/main/emptyDelete.ts). */
interface EmptyDeleteReply {
  ok: boolean;
  error?: string;
  deleted?: number;
  failed?: { kind: "canvas" | "doc" | "workflow"; id: string }[];
  cancelled?: boolean;
}
/** Answer of `empty:filter-menu` (see RecentFilterChoice in src/main/menu.ts). */
type RecentFilterChoice =
  | { action: "kind"; kind: "canvas" | "doc" | "workflow"; checked: boolean }
  | { action: "modified"; modified: "any" | "today" | "7d" | "30d" }
  | { action: "reset" };
/** One row of the Recent list (src/main/recentItems.ts). */
interface RecentItem {
  kind: "canvas" | "doc" | "workflow";
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
  openItem: (kind: "canvas" | "doc" | "workflow", id: string) => ipcRenderer.send("empty:open", { kind, id }),
  /** Right-click on a Recent row: main pops the native menu (Open, reveal file). */
  openItemMenu: (kind: "canvas" | "doc" | "workflow", id: string) => ipcRenderer.send("empty:recent-menu", { kind, id }),
  /**
   * Filter button: main pops the native filter menu at `anchor` (the button's bottom-left, empty-view CSS px).
   * Resolves the picked choice, or null when the menu closed without one.
   */
  openFilterMenu: async (
    anchor: { x: number; y: number },
    state: { kinds: { canvas: boolean; doc: boolean; workflow: boolean }; modified: "any" | "today" | "7d" | "30d" },
  ): Promise<RecentFilterChoice | null> => {
    const result: unknown = await ipcRenderer.invoke("empty:filter-menu", { ...anchor, ...state });
    return typeof result === "object" && result !== null ? (result as RecentFilterChoice) : null;
  },
  /** Bulk delete: main shows a native confirm, then removes the files. `cancelled` = the user said no. */
  deleteItems: async (items: { kind: "canvas" | "doc" | "workflow"; id: string }[]): Promise<EmptyDeleteReply> => {
    const result: unknown = await ipcRenderer.invoke("empty:delete", { items });
    return typeof result === "object" && result !== null ? (result as EmptyDeleteReply) : { ok: false };
  },
  /** Main says a document, canvas or workflow was stored or deleted: the Recent list may be out of date. */
  onRecentChanged: (cb: () => void) => {
    ipcRenderer.on("empty:recent-changed", () => cb());
  },
  onState: (cb: (state: EmptyState) => void) => {
    ipcRenderer.on("tabbar:theme", (_e: IpcRendererEvent, state: EmptyState) => cb(state));
  },
};

contextBridge.exposeInMainWorld("penEmpty", api);
