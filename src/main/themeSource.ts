import type { UITheme } from "./tabManager";

/**
 * Which theme the Passwords window follows. Every main window pushes the theme
 * its tab bar shows under its own key. The effective theme is that of the main
 * window the user focused last; when that window is gone (or none was focused
 * yet) the most recent push of any open main window applies; with no main
 * window left (e.g. on macOS) the system theme applies again. Pure and
 * Electron-free, so it is unit-tested.
 */
export function createThemeSource(system: () => UITheme) {
  const pushed = new Map<unknown, UITheme>();
  let focused: unknown = null;

  const current = (): UITheme => {
    if (focused !== null) {
      const t = pushed.get(focused);
      if (t !== undefined) return t;
    }
    let last: UITheme | undefined;
    for (const t of pushed.values()) last = t; // insertion order: the latest push is last
    return last ?? system();
  };

  return {
    /**
     * Records a window's pushed theme; `theme: null` withdraws it (the window
     * closed). Returns true when the effective theme changed because of it.
     */
    set(key: unknown, theme: UITheme | null): boolean {
      const before = current();
      pushed.delete(key); // re-insert so the latest push is last
      if (theme !== null) pushed.set(key, theme);
      else if (focused === key) focused = null;
      return current() !== before;
    },
    /** Marks `key` as the main window the user focused last. Returns true when the effective theme changed. */
    focus(key: unknown): boolean {
      const before = current();
      focused = key;
      return current() !== before;
    },
    current,
  };
}
