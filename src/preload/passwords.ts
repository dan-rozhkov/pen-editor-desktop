import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

// The Passwords window's only bridge. Every call is a request/response; main
// checks the sender. No password ever comes back through any of these.
const api = {
  isMac: process.platform === "darwin",
  list: (): Promise<unknown> => ipcRenderer.invoke("passwords:list"),
  add: (payload: { site: string; username: string; password: string; label?: string; replace?: boolean }): Promise<unknown> =>
    ipcRenderer.invoke("passwords:add", payload),
  update: (payload: { id: string; username: string; password?: string; label?: string }): Promise<unknown> =>
    ipcRenderer.invoke("passwords:update", payload),
  remove: (id: string): Promise<unknown> => ipcRenderer.invoke("passwords:remove", id),
  removeNever: (host: string): Promise<unknown> => ipcRenderer.invoke("passwords:never-remove", host),
  onTheme: (cb: (payload: { theme: "light" | "dark"; vibrancyMatches: boolean }) => void): void => {
    ipcRenderer.on("passwords:theme", (_e: IpcRendererEvent, payload: { theme: "light" | "dark"; vibrancyMatches: boolean }) => cb(payload));
  },
  onChanged: (cb: () => void): void => {
    ipcRenderer.on("passwords:changed", () => cb());
  },
};

contextBridge.exposeInMainWorld("penPasswords", api);
