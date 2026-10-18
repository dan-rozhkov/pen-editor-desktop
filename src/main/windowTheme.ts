import type { UITheme } from "./tabManager";

export interface WindowThemeInput {
  /** Theme TabManager reports for the active tab (an editor's own, or the last editor's); null when no editor reported one. */
  activeTheme: UITheme | null;
  /** The last editor theme this window ever saw, or null before any editor reported. */
  remembered: UITheme | null;
  system: UITheme;
}

/**
 * The theme the window chrome (tab bar, panel, placeholder, rim) renders.
 * An editor's theme wins and is remembered. With no editor tab to ask (zero
 * tabs, or only browser tabs after the last editor closed) the remembered
 * editor theme keeps applying, so the chrome does not flip to the OS theme
 * when the last tab closes. The agent panel cannot report a theme itself: its
 * preload exposes no theme channel, so the editor theme is the only source.
 * The system theme applies only before any editor ever reported.
 */
export function resolveWindowTheme(input: WindowThemeInput): { theme: UITheme; remembered: UITheme | null } {
  if (input.activeTheme !== null) return { theme: input.activeTheme, remembered: input.activeTheme };
  return { theme: input.remembered ?? input.system, remembered: input.remembered };
}
