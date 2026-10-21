import { createPasswordsApi, type PasswordsIcons } from "./browser/passwordsApi";
import type { CredentialStore } from "./browser/credentialStore";
import type { UITheme } from "./tabManager";

/** The slice of a `webContents` the service needs. Kept as a port so it is unit-tested without Electron. */
export interface PasswordsContents {
  readonly id: number;
  isDestroyed(): boolean;
  /** `passwords:theme` (main -> the page). */
  sendTheme(payload: { theme: UITheme }): void;
  /** Optional: repaint the view's own background for `theme` (the page-less area before first paint). Called with every theme sent. */
  setBackground?(theme: UITheme): void;
  /** `passwords:changed` (main -> the page). */
  sendChanged(): void;
  /** Fires on every page load (`did-finish-load`): a fresh page needs the theme again. */
  onLoaded(cb: () => void): void;
  /** Fires once when the webContents is destroyed. */
  onDestroyed(cb: () => void): void;
}

export interface PasswordsServiceDeps {
  /** The real `ipcMain`, narrowed to `handle` / `removeHandler`. Called once per channel, when the service is created (handlers are process-global). */
  ipcMain: { handle(channel: string, listener: (event: { sender: { id: number } }, ...args: unknown[]) => unknown): void; removeHandler(channel: string): void };
}

const DENIED = { ok: false, error: "Not allowed." };

/**
 * The saved-logins service behind the Passwords tab. App-scoped like the store: index.ts makes one,
 * so the five invoke/handle channels are registered exactly once (`ipcMain.handle` is process-global
 * and throws on a second registration). Each handler answers only webContents that were `attach`ed,
 * i.e. the Passwords tabs of any main window; everything else gets `{ ok: false }`. The renderer never
 * receives a password (see browser/passwordsApi.ts).
 */
export function createPasswordsService(store: CredentialStore, icons: PasswordsIcons | undefined, deps: PasswordsServiceDeps) {
  const api = createPasswordsApi(store, icons);
  const attached = new Map<number, { contents: PasswordsContents; owner: unknown; lastTheme: UITheme | null }>();

  const allowed = (e: { sender: { id: number } }): boolean => attached.has(e.sender.id);
  /** Tells every Passwords tab except the sender (which re-renders itself) that the stored data changed. */
  const notifyOthers = (senderId: number): void => {
    for (const [id, { contents }] of attached) if (id !== senderId && !contents.isDestroyed()) contents.sendChanged();
  };
  /** Runs a mutating call; after a success the other tabs are told. */
  const mutating = <R extends { ok: boolean }>(e: { sender: { id: number } }, run: () => R): R | typeof DENIED => {
    if (!allowed(e)) return DENIED;
    const result = run();
    if (result.ok) notifyOthers(e.sender.id);
    return result;
  };
  deps.ipcMain.handle("passwords:list", (e) => (allowed(e) ? api.list() : DENIED));
  deps.ipcMain.handle("passwords:add", (e, payload) => mutating(e, () => api.add(payload)));
  deps.ipcMain.handle("passwords:update", (e, payload) => mutating(e, () => api.update(payload)));
  deps.ipcMain.handle("passwords:remove", (e, id) => mutating(e, () => api.remove(id)));
  deps.ipcMain.handle("passwords:never-remove", (e, host) => mutating(e, () => api.removeNever(host)));

  const sendTheme = (id: number, theme: UITheme, force: boolean): void => {
    const entry = attached.get(id);
    if (!entry || entry.contents.isDestroyed()) return;
    if (!force && entry.lastTheme === theme) return;
    entry.lastTheme = theme;
    entry.contents.setBackground?.(theme);
    entry.contents.sendTheme({ theme });
  };

  return {
    /**
     * Marks a webContents as a Passwords tab of the window `owner` (any key; the window's own object).
     * `currentTheme` is the theme that window's tab bar shows; it is pushed on every page load.
     */
    attach(contents: PasswordsContents, owner: unknown, currentTheme: () => UITheme): void {
      attached.set(contents.id, { contents, owner, lastTheme: null });
      contents.onLoaded(() => sendTheme(contents.id, currentTheme(), true));
      contents.onDestroyed(() => void attached.delete(contents.id));
    },
    /** The window `owner`'s resolved theme changed: tell its Passwords tabs (an unchanged value is not re-sent). */
    setTheme(owner: unknown, theme: UITheme): void {
      for (const [id, entry] of attached) if (entry.owner === owner) sendTheme(id, theme, false);
    },
    /** A site icon arrived: every Passwords tab re-reads `passwords:list`. */
    notifyChanged(): void {
      for (const { contents } of attached.values()) if (!contents.isDestroyed()) contents.sendChanged();
    },
    /** Removes the five handlers (app shutdown, or a test); the service is unusable afterwards. */
    dispose(): void {
      deps.ipcMain.removeHandler("passwords:list");
      deps.ipcMain.removeHandler("passwords:add");
      deps.ipcMain.removeHandler("passwords:update");
      deps.ipcMain.removeHandler("passwords:remove");
      deps.ipcMain.removeHandler("passwords:never-remove");
      attached.clear();
    },
  };
}

export type PasswordsService = ReturnType<typeof createPasswordsService>;
