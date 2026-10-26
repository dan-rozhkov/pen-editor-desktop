import * as fs from "node:fs";
import * as path from "node:path";

/** The user's built-in browser switches (Settings > Browser). One file in userData, shared by dev and prod. */
export interface BrowserSettings {
  /** Block ads and trackers in the shared browser partition (see "Ad and tracker blocking"). */
  adBlock: boolean;
  /**
   * Lets MCP clients drive the shared browser through the `browse_*` tools (McpService gates every call on it).
   * OFF by default: any local MCP client could otherwise drive the user's logged-in browser.
   */
  mcpBrowser: boolean;
}

export const BROWSER_SETTINGS_FILE = "browser-settings.json";

export function defaultBrowserSettings(): BrowserSettings {
  return { adBlock: true, mcpBrowser: false };
}

/** Missing/corrupt file or a wrong type falls back to the default, per field. Unknown fields are ignored. */
export function readBrowserSettings(filePath: string): BrowserSettings {
  const settings = defaultBrowserSettings();
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      if (typeof rec.adBlock === "boolean") settings.adBlock = rec.adBlock;
      if (typeof rec.mcpBrowser === "boolean") settings.mcpBrowser = rec.mcpBrowser;
    }
  } catch {
    // defaults
  }
  return settings;
}

/** Best effort: a failed write must never break the app; returns success. */
export function writeBrowserSettings(filePath: string, settings: BrowserSettings): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

export type BrowserSettingsPatch = Partial<BrowserSettings>;

/**
 * Validates a `browser-settings:set` payload: a plain object whose only keys are `adBlock` / `mcpBrowser`,
 * each a boolean when present. Anything else (null, array, other keys, non-boolean values) returns null.
 * An empty object is a valid no-op patch.
 */
export function parseBrowserSettingsPatch(raw: unknown): BrowserSettingsPatch | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) return null;
  const rec = raw as Record<string, unknown>;
  const out: BrowserSettingsPatch = {};
  for (const key of Object.keys(rec)) {
    if (key !== "adBlock" && key !== "mcpBrowser") return null;
    const v = rec[key];
    if (typeof v !== "boolean") return null;
    out[key] = v;
  }
  return out;
}

export interface BrowserSettingsStore {
  get(): BrowserSettings;
  /**
   * Merges a patch, writes the file and notifies subscribers when a value changed. Returns the new settings, or
   * null when the file could not be written: then nothing changed in memory and nobody was notified.
   */
  set(patch: BrowserSettingsPatch): BrowserSettings | null;
  /** Subscribes to changes (called with the new settings, only when a value actually changed). Returns the unsubscribe. */
  onChange(cb: (settings: BrowserSettings) => void): () => void;
}

/** ONE per process (index.ts). The file is read once, synchronously: it is a few bytes. */
export function createBrowserSettingsStore(filePath: string): BrowserSettingsStore {
  let current = readBrowserSettings(filePath);
  const listeners = new Set<(s: BrowserSettings) => void>();
  return {
    get: () => ({ ...current }),
    set(patch) {
      const next: BrowserSettings = { ...current, ...patch };
      if (next.adBlock === current.adBlock && next.mcpBrowser === current.mcpBrowser) return { ...current };
      if (!writeBrowserSettings(filePath, next)) return null;
      current = next;
      for (const cb of [...listeners]) {
        try {
          cb({ ...current });
        } catch (err) {
          console.error("[browser-settings] listener failed", err);
        }
      }
      return { ...current };
    },
    onChange(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
}
