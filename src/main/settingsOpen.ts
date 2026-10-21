import { isValidSettingsSection } from "./config";

/** What `settings:open` needs from the window. Kept as a port so the rule is unit-tested without Electron. */
export interface SettingsOpenDeps {
  /** True only for this window's agent panel webContents. */
  isPanel(webContentsId: number): boolean;
  /** True for this window's editor, doc, trace and Settings tabs; browser tabs are not allowed. */
  isPageTab(webContentsId: number): boolean;
  /** Opens the Settings tab, or activates the existing one (a singleton), with keyboard focus. A valid section points it at that section. */
  openSettingsTab(section: string | undefined): void;
}

export type SettingsOpenResult = { ok: boolean };

/**
 * `settings:open` (invoke, agent panel or any frontend tab of this window). The section is optional:
 * an unknown or non-string one is ignored (the tab still opens). A person asked for the page, so the
 * tab takes keyboard focus. Never throws: the sender gets `{ok:false}`.
 */
export function openSettings(deps: SettingsOpenDeps, sender: number, section: unknown): SettingsOpenResult {
  if (!deps.isPanel(sender) && !deps.isPageTab(sender)) return { ok: false };
  try {
    deps.openSettingsTab(isValidSettingsSection(section) ? section : undefined);
    return { ok: true };
  } catch (err) {
    console.error("settings:open failed", err);
    return { ok: false };
  }
}
