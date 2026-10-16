import path from "node:path";
import { BaseWindow, ipcMain, WebContentsView, nativeTheme } from "electron";
import { attachLocalOnlyPolicy } from "./navigation";
import type { UITheme } from "./tabManager";
import { createPasswordsApi, type PasswordsIcons } from "./browser/passwordsApi";
import type { CredentialStore } from "./browser/credentialStore";
import { createThemeSource } from "./themeSource";

/**
 * The Passwords window: a small, single-instance BaseWindow with one
 * WebContentsView (src/passwords/). App-scoped like the store: index.ts makes
 * one manager, so a second "Passwords…" click focuses the open window.
 *
 * The five invoke/handle channels are registered while the window is open and
 * removed when it closes (no listener leak across close/reopen). Each handler
 * answers only the window's own webContents. The renderer never receives a
 * password (see browser/passwordsApi.ts).
 */
export function createPasswordsWindow(store: CredentialStore, icons?: PasswordsIcons) {
  const api = createPasswordsApi(store, icons);
  let win: BaseWindow | null = null;
  let view: WebContentsView | null = null;

  const fromOurView = (event: Electron.IpcMainInvokeEvent): boolean =>
    view !== null && !view.webContents.isDestroyed() && event.sender.id === view.webContents.id;

  const denied = { ok: false, error: "Not allowed." };

  // The theme the tab bar shows (active editor theme, else system), pushed by
  // each main window (window.ts) under its own key. With no pushing window the
  // system theme applies and nativeTheme updates are followed (themeSource.ts).
  const systemTheme = (): UITheme => (nativeTheme.shouldUseDarkColors ? "dark" : "light");
  const themeSource = createThemeSource(systemTheme);
  const BACKGROUND: Record<UITheme, string> = { light: "#ffffff", dark: "#2a2a2a" };
  // What the window last got; null until its page has loaded (a fresh page needs the push).
  let lastSent: { theme: UITheme; vibrancyMatches: boolean } | null = null;
  const sendTheme = (force = false): void => {
    const theme = themeSource.current();
    // macOS vibrancy follows the OS appearance, not the editor theme: when they
    // differ the renderer paints the sidebar opaque instead of glass.
    const vibrancyMatches = theme === systemTheme();
    if (!force && lastSent && lastSent.theme === theme && lastSent.vibrancyMatches === vibrancyMatches) return;
    lastSent = { theme, vibrancyMatches };
    if (view && !view.webContents.isDestroyed()) view.webContents.send("passwords:theme", { theme, vibrancyMatches });
    if (win && !win.isDestroyed() && process.platform !== "darwin") win.setBackgroundColor(BACKGROUND[theme]);
  };
  const onSystemTheme = (): void => sendTheme();

  return {
    /** True while the Passwords window is the focused window. */
    isFocused(): boolean {
      return win !== null && !win.isDestroyed() && win.isFocused();
    },
    /** True when `w` is the Passwords window (not a main window). */
    owns(w: unknown): boolean {
      return win !== null && w === win;
    },
    /** Called by window.ts on every tab-bar theme push; `null` withdraws that window's push (it closed). */
    setTheme(source: unknown, theme: UITheme | null): void {
      themeSource.set(source, theme);
      sendTheme();
    },
    /** A main window got focus: the Passwords window follows its theme from now on. */
    focusMain(source: unknown): void {
      themeSource.focus(source);
      sendTheme();
    },
    /** Tells the open window that the list changed (a site icon arrived); it re-reads `passwords:list`. */
    notifyChanged(): void {
      if (view && !view.webContents.isDestroyed()) view.webContents.send("passwords:changed");
    },
    close(): void {
      if (win && !win.isDestroyed()) win.close();
    },
    open(): void {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.focus();
        return;
      }
      const created = new BaseWindow({
        width: 980,
        height: 620,
        minWidth: 860,
        minHeight: 540,
        title: "Passwords",
        ...(process.platform === "darwin"
          ? {
              // Traffic lights sit over the sidebar. A vibrant window is
              // non-opaque: the sidebar's translucent tint shows the blur,
              // the list and detail panes paint opaque (passwords.css).
              titleBarStyle: "hiddenInset" as const,
              // 12px lights centred in the 52px top strip shared with the
              // search field and the Edit/Delete row (passwords.css).
              trafficLightPosition: { x: 14, y: 20 },
              vibrancy: "sidebar" as const,
              visualEffectState: "active" as const,
            }
          : { backgroundColor: BACKGROUND[themeSource.current()] }),
      });
      const contents = new WebContentsView({
        webPreferences: {
          preload: path.join(__dirname, "../preload/passwords.js"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      win = created;
      view = contents;
      if (process.platform === "darwin") contents.setBackgroundColor("#00000000");
      created.contentView.addChildView(contents);
      lastSent = null;
      contents.webContents.on("did-finish-load", () => sendTheme(true));
      nativeTheme.on("updated", onSystemTheme);
      attachLocalOnlyPolicy(contents.webContents);
      const layout = () => {
        const { width, height } = created.getContentBounds();
        contents.setBounds({ x: 0, y: 0, width, height });
      };
      created.on("resize", layout);
      layout();
      void contents.webContents.loadFile(path.join(__dirname, "../passwords/passwords.html"));

      ipcMain.handle("passwords:list", (e) => (fromOurView(e) ? api.list() : denied));
      ipcMain.handle("passwords:add", (e, payload: unknown) => (fromOurView(e) ? api.add(payload) : denied));
      ipcMain.handle("passwords:update", (e, payload: unknown) => (fromOurView(e) ? api.update(payload) : denied));
      ipcMain.handle("passwords:remove", (e, id: unknown) => (fromOurView(e) ? api.remove(id) : denied));
      ipcMain.handle("passwords:never-remove", (e, host: unknown) => (fromOurView(e) ? api.removeNever(host) : denied));

      created.on("closed", () => {
        ipcMain.removeHandler("passwords:list");
        ipcMain.removeHandler("passwords:add");
        ipcMain.removeHandler("passwords:update");
        ipcMain.removeHandler("passwords:remove");
        nativeTheme.removeListener("updated", onSystemTheme);
        ipcMain.removeHandler("passwords:never-remove");
        if (!contents.webContents.isDestroyed()) contents.webContents.close();
        win = null;
        view = null;
      });
    },
  };
}

export type PasswordsWindow = ReturnType<typeof createPasswordsWindow>;
