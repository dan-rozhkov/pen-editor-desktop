import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

// The History tab's only bridge. Every call is a request/response; main checks the sender.
const api = {
  list: (query?: string): Promise<unknown> => ipcRenderer.invoke("history:list", { query }),
  remove: (url: string): Promise<unknown> => ipcRenderer.invoke("history:remove", { url }),
  clear: (): Promise<unknown> => ipcRenderer.invoke("history:clear"),
  open: (url: string): Promise<unknown> => ipcRenderer.invoke("history:open", { url }),
  onTheme: (cb: (payload: { theme: "light" | "dark" }) => void): void => {
    ipcRenderer.on("history:theme", (_e: IpcRendererEvent, payload: { theme: "light" | "dark" }) => cb(payload));
  },
  onChanged: (cb: () => void): void => {
    ipcRenderer.on("history:changed", () => cb());
  },
};

contextBridge.exposeInMainWorld("penHistory", api);
