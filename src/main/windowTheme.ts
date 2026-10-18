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

export interface PanelThemeState {
  remembered: UITheme | null;
  /** True while `remembered` came from the agent panel page, not from an editor tab. */
  fromPanel: boolean;
}

/**
 * Agent layout: the panel page paints the stored editor theme (`html.dark`) and
 * has no channel to tell main. With no editor tab having reported a theme yet,
 * main adopts what it reads from the panel page; once an editor reported
 * (`fromPanel` false, remembered set) the panel's value is ignored.
 */
export function adoptPanelTheme(state: PanelThemeState, panelTheme: UITheme): PanelThemeState & { changed: boolean } {
  if (state.remembered !== null && !state.fromPanel) return { ...state, changed: false };
  return { remembered: panelTheme, fromPanel: true, changed: state.remembered !== panelTheme };
}

/** True when `url` is a document of the panel page (same origin, panel path or a subpath), not e.g. the offline fallback. */
export function isPanelDocument(url: string, panelUrl: string): boolean {
  try {
    const u = new URL(url);
    const p = new URL(panelUrl);
    if (u.origin !== p.origin) return false;
    const base = p.pathname.replace(/\/+$/, "");
    return u.pathname === p.pathname || u.pathname === base || u.pathname.startsWith(`${base}/`);
  } catch {
    return false;
  }
}

export interface GlassTint {
  /** CSS colour of the translucent layer under the islands. */
  color: string;
  alpha: number;
}

/** Tint base colours per editor theme. */
const GLASS_BASE: Record<UITheme, [number, number, number]> = { light: [244, 245, 248], dark: [28, 28, 30] };
/** Alpha when the editor theme matches the OS appearance (the wallpaper stays visible) / differs (the tint must win over the vibrancy). */
export const GLASS_ALPHA_SAME = 0.35;
export const GLASS_ALPHA_DIFFERENT = 0.85;

/**
 * Agent layout glass tint. The vibrancy follows the OS appearance and cannot be
 * changed per window, so a translucent layer of the editor theme's colour is
 * drawn over it: light when both agree, stronger when they differ.
 */
export function glassTint(theme: UITheme, osDark: boolean): GlassTint {
  const same = (theme === "dark") === osDark;
  const alpha = same ? GLASS_ALPHA_SAME : GLASS_ALPHA_DIFFERENT;
  const [r, g, b] = GLASS_BASE[theme];
  return { color: `rgba(${r}, ${g}, ${b}, ${alpha})`, alpha };
}
