import path from "node:path";
import { BaseWindow, ipcMain, WebContentsView, nativeTheme } from "electron";
import { attachLocalOnlyPolicy } from "./navigation";
import { createPasswordsApi } from "./browser/passwordsApi";
import type { CredentialStore } from "./browser/credentialStore";

/**
 * The Passwords window: a small, single-instance BaseWindow with one
 * WebContentsView (src/passwords/). App-scoped like the store: index.ts makes
 * one manager, so a second "Passwords…" click focuses the open window.
 *
 * The four invoke/handle channels are registered while the window is open and
 * removed when it closes (no listener leak across close/reopen). Each handler
 * answers only the window's own webContents. The renderer never receives a
 * password (see browser/passwordsApi.ts).
 */
export function createPasswordsWindow(store: CredentialStore) {
  const api = createPasswordsApi(store);
  let win: BaseWindow | null = null;
  let view: WebContentsView | null = null;

  const fromOurView = (event: Electron.IpcMainInvokeEvent): boolean =>
    view !== null && !view.webContents.isDestroyed() && event.sender.id === view.webContents.id;

  const denied = { ok: false, error: "Not allowed." };

  return {
    /** True while the Passwords window is the focused window. */
    isFocused(): boolean {
      return win !== null && !win.isDestroyed() && win.isFocused();
    },
    /** True when `w` is the Passwords window (not a main window). */
    owns(w: unknown): boolean {
      return win !== null && w === win;
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
      const dark = nativeTheme.shouldUseDarkColors;
      const created = new BaseWindow({
        width: 560,
        height: 640,
        minWidth: 420,
        minHeight: 360,
        title: "Passwords",
        backgroundColor: dark ? "#1a1a1a" : "#ffffff",
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
      created.contentView.addChildView(contents);
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
      ipcMain.handle("passwords:remove", (e, id: unknown) => (fromOurView(e) ? api.remove(id) : denied));
      ipcMain.handle("passwords:never-remove", (e, host: unknown) => (fromOurView(e) ? api.removeNever(host) : denied));

      created.on("closed", () => {
        ipcMain.removeHandler("passwords:list");
        ipcMain.removeHandler("passwords:add");
        ipcMain.removeHandler("passwords:remove");
        ipcMain.removeHandler("passwords:never-remove");
        if (!contents.webContents.isDestroyed()) contents.webContents.close();
        win = null;
        view = null;
      });
    },
  };
}

export type PasswordsWindow = ReturnType<typeof createPasswordsWindow>;
