import * as path from "node:path";
import { app } from "electron";
import { BROWSER_SETTINGS_FILE, createBrowserSettingsStore, type BrowserSettingsStore } from "./browserSettings";

let store: BrowserSettingsStore | undefined;

/**
 * THE settings store of the process, created on the FIRST call (never at import): index.ts imports this module before
 * it calls `app.setPath("userData", ...)`, so an import-time store would read and write the default Electron folder
 * and bypass PEN_DESKTOP_USER_DATA_DIR. Every caller uses the getter at use time and gets the same instance.
 */
export function getBrowserSettings(): BrowserSettingsStore {
  store ??= createBrowserSettingsStore(path.join(app.getPath("userData"), BROWSER_SETTINGS_FILE));
  return store;
}
