import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const api = {
  onMenuCommand(cb: (commandId: string) => void): () => void {
    const listener = (_e: IpcRendererEvent, commandId: string) => cb(commandId);
    ipcRenderer.on("menu:command", listener);
    return () => ipcRenderer.removeListener("menu:command", listener);
  },
};

contextBridge.exposeInMainWorld("penDesktop", api);
