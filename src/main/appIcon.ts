import * as fs from "node:fs";
import * as path from "node:path";

/** The three app icons the user can pick (Settings > Appearance). Pure module: no electron import; the caller
 * passes paths and the Dock/preview ports, so tests can use a temp dir and fakes. */
export const APP_ICON_IDS = ["white", "black", "shader"] as const;
export type AppIconId = (typeof APP_ICON_IDS)[number];
export const DEFAULT_APP_ICON: AppIconId = "white";
export const APP_ICON_LABELS: Record<AppIconId, string> = { white: "White", black: "Black", shader: "Gradient" };

export const APP_ICON_SETTINGS_FILE = "app-icon-settings.json";

export function parseAppIconId(value: unknown): AppIconId | null {
  return typeof value === "string" && (APP_ICON_IDS as readonly string[]).includes(value) ? (value as AppIconId) : null;
}

/** Missing/corrupt file or an unknown id -> the default. */
export function readAppIconSettings(filePath: string): AppIconId {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      return parseAppIconId((parsed as Record<string, unknown>).icon) ?? DEFAULT_APP_ICON;
    }
  } catch {
    // fall through to the default
  }
  return DEFAULT_APP_ICON;
}

/** Best effort: never throws; returns success. */
export function writeAppIconSettings(filePath: string, id: AppIconId): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ icon: id }, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** macOS only. A dev run shows Electron's icon unless we set ours; a packaged default keeps the system-drawn bundle icon. */
export function shouldApplyAtStartup(opts: { platform: string; isPackaged: boolean; icon: AppIconId }): boolean {
  if (opts.platform !== "darwin") return false;
  return !opts.isPackaged || opts.icon !== DEFAULT_APP_ICON;
}

export function appIconPath(assetsDir: string, id: AppIconId): string {
  return path.join(assetsDir, `${id}.png`);
}

export interface AppIconOption {
  id: AppIconId;
  label: string;
  preview: string;
}
export interface AppIconState {
  selected: AppIconId;
  options: AppIconOption[];
}

export interface AppIconServiceDeps {
  platform: string;
  isPackaged: boolean;
  settingsPath: string;
  assetsDir: string;
  /** Sets the Dock icon from a PNG path; null restores the bundle icon. Throws when the PNG cannot be loaded. */
  setDockIcon(pngPath: string | null): void;
  /** A `data:image/png;base64,...` URL for a PNG path. Throws when the PNG cannot be loaded. */
  preview(pngPath: string): string;
}

export interface AppIconService {
  applyAtStartup(): void;
  state(): AppIconState;
  set(id: AppIconId): AppIconState | { error: string };
}

export function createAppIconService(deps: AppIconServiceDeps): AppIconService {
  let selected = readAppIconSettings(deps.settingsPath);

  /** A packaged default goes back to the system-drawn bundle icon, not a static PNG. */
  function applyDock(id: AppIconId): boolean {
    const useBundleIcon = deps.isPackaged && id === DEFAULT_APP_ICON;
    try {
      deps.setDockIcon(useBundleIcon ? null : appIconPath(deps.assetsDir, id));
      return true;
    } catch (err) {
      console.warn("[app-icon] could not set the Dock icon", err);
      return false;
    }
  }
  function previewOf(id: AppIconId): string {
    try {
      return deps.preview(appIconPath(deps.assetsDir, id));
    } catch (err) {
      console.warn("[app-icon] could not build a preview", err);
      return "";
    }
  }

  const service: AppIconService = {
    applyAtStartup() {
      if (shouldApplyAtStartup({ platform: deps.platform, isPackaged: deps.isPackaged, icon: selected })) applyDock(selected);
    },
    state() {
      // The Dock is macOS only: an empty list hides the picker elsewhere.
      if (deps.platform !== "darwin") return { selected, options: [] };
      return { selected, options: APP_ICON_IDS.map((id) => ({ id, label: APP_ICON_LABELS[id], preview: previewOf(id) })) };
    },
    set(id) {
      if (deps.platform !== "darwin") return { error: "App icons are available on macOS only." };
      // The Dock first: a choice that cannot be shown must not be saved and reapplied on every launch.
      if (!applyDock(id)) return { error: "Could not change the icon." };
      if (!writeAppIconSettings(deps.settingsPath, id)) {
        applyDock(selected);
        return { error: "Could not save the setting." };
      }
      selected = id;
      return service.state();
    },
  };
  return service;
}
