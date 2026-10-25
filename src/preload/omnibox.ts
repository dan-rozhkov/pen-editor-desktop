import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type Item = { url: string; title: string; lastVisitedAt: number };
type RenderPayload = { items: Item[]; selected: number; query: string; theme: "light" | "dark"; isMac: boolean };

// The address-bar suggestion popover only paints what the tab bar sends (through main) and reports clicks.
const api = {
  onRender: (cb: (p: RenderPayload) => void) => {
    ipcRenderer.on("omnibox:render", (_e: IpcRendererEvent, p: RenderPayload) => cb(p));
  },
  pick: (url: string) => ipcRenderer.send("omnibox:pick", { url }),
  remove: (url: string) => ipcRenderer.send("omnibox:remove", { url }),
  openHistory: () => ipcRenderer.send("omnibox:open-history"),
};

contextBridge.exposeInMainWorld("penOmnibox", api);
