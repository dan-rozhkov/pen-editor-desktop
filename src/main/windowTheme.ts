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
 * has no channel to tell main. Main adopts what it reads from the panel while
 * no editor has reported a theme, and whenever there are ZERO editor tabs (a
 * remembered editor theme is stale then: the user may have switched the panel
 * after the last editor tab closed). While an editor tab exists and reported,
 * its theme wins and the panel's value is ignored.
 */
export function adoptPanelTheme(
  state: PanelThemeState,
  panelTheme: UITheme,
  editorTabs: number,
): PanelThemeState & { changed: boolean } {
  if (state.remembered !== null && !state.fromPanel && editorTabs > 0) return { ...state, changed: false };
  return { remembered: panelTheme, fromPanel: true, changed: state.remembered !== panelTheme };
}

/**
 * Whether main should (re-)read the panel page's theme now. Only while the panel
 * is the source (nothing remembered, remembered from the panel, or no editor tab);
 * `throttleMs` rate-limits the per-push reads (0 for focus / document load).
 */
export function shouldReadPanelTheme(input: {
  remembered: UITheme | null;
  fromPanel: boolean;
  editorTabs: number;
  now: number;
  lastRead: number;
  throttleMs: number;
}): boolean {
  const panelIsSource = input.remembered === null || input.fromPanel || input.editorTabs === 0;
  return panelIsSource && input.now - input.lastRead >= input.throttleMs;
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

// --- agent layout colours: the ONE TS place (the CSS twin is tokens.css `--island-bg`,
// pinned equal by test/windowTheme.test.ts) ---

/** Island surface = the frontend's `--color-surface-panel` (pen-editor index.css). Also the agent panel / tab content / empty view background. */
export const ISLAND_BG: Record<UITheme, string> = { light: "#ffffff", dark: "#2a2a2a" };
/** Flag-off tab content background in dark (unchanged historical value). */
const LEGACY_DARK_CONTENT_BG = "#1a1a1a";
/** Non-macOS stand-in for the glass behind the islands. */
export const GLASS_SOLID: Record<UITheme, string> = { light: "#e4e6ea", dark: "#2b2b2e" };

/** Opaque background of tab content views / panel / placeholder (never flashes white in dark). */
export function contentBackground(theme: UITheme, agentLayout: boolean): string {
  if (theme === "light") return ISLAND_BG.light;
  return agentLayout ? ISLAND_BG.dark : LEGACY_DARK_CONTENT_BG;
}

/** The theme assumed before any editor or the panel reported: the agent layout's frontend ignores the OS (stored `ui-theme`, default light). */
export function fallbackTheme(agentLayout: boolean, osDark: boolean): UITheme {
  if (agentLayout) return "light";
  return osDark ? "dark" : "light";
}
