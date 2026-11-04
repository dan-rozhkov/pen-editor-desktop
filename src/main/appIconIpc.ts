import { parseAppIconId, type AppIconService, type AppIconState } from "./appIcon";
import { isSettingsSender, NOT_ALLOWED, type BrowserSettingsIpcDeps, type SettingsWindowPort } from "./browserSettingsIpc";

export interface AppIconIpcDeps {
  ipcMain: BrowserSettingsIpcDeps["ipcMain"];
  service: Pick<AppIconService, "state" | "set">;
}

export interface AppIconIpc {
  /** Lends one window's Settings-tab check. Returns the withdrawal (call it when the window closes). */
  addWindow(port: SettingsWindowPort): () => void;
  /** Removes both handlers (will-quit). */
  dispose(): void;
}

/** `app-icon:get` / `app-icon:set` (invoke). Same sender rule as `browser-settings:*`. Created once per process. Never throws. */
export function createAppIconIpc(deps: AppIconIpcDeps): AppIconIpc {
  const ports = new Set<SettingsWindowPort>();
  deps.ipcMain.handle("app-icon:get", (e): AppIconState | { error: string } => {
    if (!isSettingsSender(ports, e)) return NOT_ALLOWED;
    try {
      return deps.service.state();
    } catch {
      return { error: "Could not read the icon." };
    }
  });
  deps.ipcMain.handle("app-icon:set", (e, id): AppIconState | { error: string } => {
    if (!isSettingsSender(ports, e)) return NOT_ALLOWED;
    const parsed = parseAppIconId(id);
    if (parsed === null) return { error: "Invalid icon." };
    try {
      return deps.service.set(parsed);
    } catch {
      return { error: "Could not save the setting." };
    }
  });
  return {
    addWindow(port) {
      ports.add(port);
      return () => void ports.delete(port);
    },
    dispose() {
      deps.ipcMain.removeHandler("app-icon:get");
      deps.ipcMain.removeHandler("app-icon:set");
    },
  };
}
