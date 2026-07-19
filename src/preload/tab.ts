import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type UITheme = "light" | "dark";

let lastTheme: UITheme | undefined;

function publishTheme(): void {
  const theme: UITheme = document.documentElement?.classList.contains("dark") ? "dark" : "light";
  if (theme === lastTheme) return;
  lastTheme = theme;
  ipcRenderer.send("editor:theme", theme);
}

const api = {
  setDocumentTitle(title: string | null): void {
    ipcRenderer.send("editor:document-title", title);
  },
  onMenuCommand(cb: (commandId: string) => void): () => void {
    const listener = (_e: IpcRendererEvent, commandId: string) => cb(commandId);
    ipcRenderer.on("menu:command", listener);
    return () => ipcRenderer.removeListener("menu:command", listener);
  },
};

contextBridge.exposeInMainWorld("penDesktop", api);

function startThemeObserver(): void {
  const root = document.documentElement;
  if (!root) return;
  publishTheme();
  new MutationObserver(publishTheme).observe(root, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

// The editor applies its UI theme by toggling `.dark` on <html>. Observing it
// here keeps the desktop chrome in sync without coupling the web app to
// Electron-specific APIs. Preloads may run before <html> exists, so defer the
// observer while exposing the public bridge immediately.
if (document.documentElement) {
  startThemeObserver();
} else {
  window.addEventListener("DOMContentLoaded", startThemeObserver, { once: true });
}
