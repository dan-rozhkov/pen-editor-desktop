import type { MenuActions } from "./menu";

/**
 * What the global "Close Tab" menu item (Cmd/Ctrl+W) closes. The menu is
 * app-wide, so it fires whichever window has focus; the Passwords window must
 * close itself, never a tab of the main window behind it.
 */
export type CloseTarget = { kind: "passwords" } | { kind: "tab"; id: number } | { kind: "none" };

export function decideCloseTarget(input: {
  passwordsFocused: boolean;
  activeTabId: number | null;
}): CloseTarget {
  if (input.passwordsFocused) return { kind: "passwords" };
  if (input.activeTabId !== null) return { kind: "tab", id: input.activeTabId };
  // Nothing to close (zero tabs, or only background isolated-session tabs): a deliberate
  // no-op. Cmd/Ctrl+W never closes the window (macOS convention: that is "Close Window",
  // Cmd/Ctrl+Shift+W), so a stray extra press cannot lose the window or kill running QA sessions.
  return { kind: "none" };
}

/**
 * How each application-menu action behaves while the Passwords window has
 * focus. The menu is app-global (one `Menu.setApplicationMenu`), so every item
 * fires whichever window is focused:
 *  - `main`: acts on the main window (tabs, the active editor tab); ignored
 *    while the Passwords window is focused, or it would change the window
 *    behind it;
 *  - `close`: Close Tab, which closes the Passwords window instead;
 *  - `app`: does not touch the main window (opening Passwords, MCP publish,
 *    cursor preferences); always runs.
 * Typed as a Record over every `MenuActions` key, so a new menu action cannot
 * be added without choosing its scope here.
 */
export const MENU_ACTION_SCOPE: Record<keyof MenuActions, "main" | "close" | "app"> = {
  newTab: "main",
  newBrowserTab: "main",
  newDocTab: "main",
  openPasswords: "app",
  closeTab: "close",
  closeWindow: "close",
  nextTab: "main",
  prevTab: "main",
  forwardToActiveTab: "main",
  useThisAppForMcp: "app",
  setCursorEnabled: "app",
  toggleAgentPanel: "main",
};

export type MenuDecision = "run" | "ignore" | "close-passwords";

export function decideMenuAction(action: keyof MenuActions, passwordsFocused: boolean): MenuDecision {
  const scope = MENU_ACTION_SCOPE[action];
  if (!passwordsFocused || scope === "app") return "run";
  return scope === "close" ? "close-passwords" : "ignore";
}

/**
 * Wraps the menu actions with `decideMenuAction`. Lives in window.ts's wiring,
 * not in menu.ts: menu.ts keeps forwarding every click untouched (pen-editor's
 * desktopMenuContract test clicks those items with recording actions).
 */
export function guardMenuActions(
  actions: MenuActions,
  passwordsFocused: () => boolean,
  closePasswords: () => void,
): MenuActions {
  const out = { ...actions } as Record<keyof MenuActions, (...args: never[]) => void>;
  for (const name of Object.keys(MENU_ACTION_SCOPE) as (keyof MenuActions)[]) {
    const original = actions[name] as (...args: never[]) => void;
    out[name] = (...args) => {
      const decision = decideMenuAction(name, passwordsFocused());
      if (decision === "run") original(...args);
      else if (decision === "close-passwords") closePasswords();
    };
  }
  return out as unknown as MenuActions;
}

/**
 * macOS `activate` (dock click) reopens a main window when none is left. The
 * Passwords window is not one, so it must not count: with only Passwords open
 * the app would otherwise stay without an editor.
 */
export function shouldReopenMainWindow<T>(windows: readonly T[], isPasswordsWindow: (w: T) => boolean): boolean {
  return windows.every(isPasswordsWindow);
}
