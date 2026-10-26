import { parseBrowserSettingsPatch, type BrowserSettings, type BrowserSettingsStore } from "./browserSettings";

/** The slice of an `ipcMain` invoke event the handlers read. `senderFrame` is the top frame iff it is `sender.mainFrame`. */
export interface BrowserSettingsEvent {
  sender: { id: number; mainFrame?: unknown };
  senderFrame?: { url?: string } | null;
}

/** One main window's Settings tab, as `browser-settings:*` sees it. */
export interface SettingsWindowPort {
  /** True for a Settings tab of this window that shows the settings page now: the view AND the sender frame's own URL. */
  isSettingsViewer(webContentsId: number, frameUrl: string | undefined): boolean;
}

export const NOT_ALLOWED = { error: "Not allowed." } as const;

export interface BrowserSettingsIpcDeps {
  ipcMain: {
    handle(channel: string, listener: (event: BrowserSettingsEvent, ...args: unknown[]) => unknown): void;
    removeHandler(channel: string): void;
  };
  store: Pick<BrowserSettingsStore, "get" | "set">;
}

export interface BrowserSettingsIpc {
  /** Lends one window's Settings-tab check. Returns the withdrawal (call it when the window closes). */
  addWindow(port: SettingsWindowPort): () => void;
  /** Removes both handlers (will-quit). */
  dispose(): void;
}

/** Top frame of a Settings tab (of any window) that still shows the settings page on the editor origin. */
export function isSettingsSender(ports: Iterable<SettingsWindowPort>, event: BrowserSettingsEvent): boolean {
  const frame = event.senderFrame;
  if (frame == null || frame !== event.sender.mainFrame) return false;
  for (const port of ports) if (port.isSettingsViewer(event.sender.id, frame.url)) return true;
  return false;
}

/**
 * `browser-settings:get` / `browser-settings:set` (invoke). `ipcMain.handle` is process-global, so this is created once
 * (index.ts); each window adds its own port. Never throws.
 */
export function createBrowserSettingsIpc(deps: BrowserSettingsIpcDeps): BrowserSettingsIpc {
  const ports = new Set<SettingsWindowPort>();
  deps.ipcMain.handle("browser-settings:get", (e): BrowserSettings | typeof NOT_ALLOWED =>
    isSettingsSender(ports, e) ? deps.store.get() : NOT_ALLOWED,
  );
  deps.ipcMain.handle("browser-settings:set", (e, payload): BrowserSettings | { error: string } => {
    if (!isSettingsSender(ports, e)) return NOT_ALLOWED;
    const patch = parseBrowserSettingsPatch(payload);
    if (patch === null) return { error: "Invalid settings." };
    return deps.store.set(patch) ?? { error: "Could not save the setting." };
  });
  return {
    addWindow(port) {
      ports.add(port);
      return () => void ports.delete(port);
    },
    dispose() {
      deps.ipcMain.removeHandler("browser-settings:get");
      deps.ipcMain.removeHandler("browser-settings:set");
    },
  };
}
