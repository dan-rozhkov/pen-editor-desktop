import { contextBridge, ipcRenderer } from "electron";

// The Passwords window's only bridge. Every call is a request/response; main
// checks the sender. No password ever comes back through any of these.
const api = {
  list: (): Promise<unknown> => ipcRenderer.invoke("passwords:list"),
  add: (payload: { site: string; username: string; password: string; label?: string }): Promise<unknown> =>
    ipcRenderer.invoke("passwords:add", payload),
  remove: (id: string): Promise<unknown> => ipcRenderer.invoke("passwords:remove", id),
  removeNever: (host: string): Promise<unknown> => ipcRenderer.invoke("passwords:never-remove", host),
};

contextBridge.exposeInMainWorld("penPasswords", api);
