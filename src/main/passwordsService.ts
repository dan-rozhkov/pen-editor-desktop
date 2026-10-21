import { DENIED, handleLoginsAdd, handleLoginsList, type LoginsCaller, type LoginsIpcDeps, type LoginsPort } from "./loginsIpc";
import { createPasswordsApi, type PasswordsIcons } from "./browser/passwordsApi";
import type { CredentialStore } from "./browser/credentialStore";
import type { UITheme } from "./tabManager";

/** The slice of an `ipcMain` invoke event the service reads: `senderFrame` is the top frame iff it is `sender.mainFrame`. */
export interface ServiceEvent {
  sender: { id: number; mainFrame?: unknown };
  senderFrame?: { url?: string } | null;
}

/** One main window's doc tabs, as `logins:*` sees them. */
export type DocWindowPort = LoginsPort;

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
  ipcMain: { handle(channel: string, listener: (event: ServiceEvent, ...args: unknown[]) => unknown): void; removeHandler(channel: string): void };
}

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

  const allowed = (e: ServiceEvent): boolean => attached.has(e.sender.id);
  /** Tells every Passwords tab except the sender (which re-renders itself) that the stored data changed. */
  const notifyOthers = (senderId: number): void => {
    for (const [id, { contents }] of attached) if (id !== senderId && !contents.isDestroyed()) contents.sendChanged();
  };
  /** Runs a mutating call; after a success the other tabs are told. */
  const mutating = <R extends { ok: boolean }>(e: ServiceEvent, run: () => R): R | typeof DENIED => {
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

  // `logins:*`: the doc tabs' mention picker (loginsIpc.ts). Registered here with the other channels because
  // handlers are process-global; each window adds its own `DocWindowPort` (`addDocWindow`) and drops it on close.
  const notifyAll = (): void => {
    for (const { contents } of attached.values()) if (!contents.isDestroyed()) contents.sendChanged();
  };
  const docWindows = new Set<DocWindowPort>();
  const loginsDeps: LoginsIpcDeps = {
    api,
    // The window owning the sender, resolved once per call: it both authorizes and asks.
    resolvePort: (id, frameUrl) => [...docWindows].find((w) => w.isDocViewer(id, frameUrl)) ?? null,
    notifyChanged: () => notifyAll(),
  };
  const callerOf = (e: ServiceEvent): LoginsCaller => ({
    senderId: e.sender.id,
    topFrame: e.senderFrame != null && e.senderFrame === e.sender.mainFrame,
    frameUrl: e.senderFrame?.url,
  });
  deps.ipcMain.handle("logins:list", (e) => handleLoginsList(loginsDeps, callerOf(e)));
  deps.ipcMain.handle("logins:add", (e, payload) => handleLoginsAdd(loginsDeps, callerOf(e), payload));

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
    notifyChanged: (): void => notifyAll(),
    /** Lets the doc tabs of one window use `logins:*`; returns the function that withdraws them (window closed). */
    addDocWindow(port: DocWindowPort): () => void {
      docWindows.add(port);
      return () => void docWindows.delete(port);
    },
    /** Removes the seven handlers (app shutdown, or a test); the service is unusable afterwards. */
    dispose(): void {
      deps.ipcMain.removeHandler("passwords:list");
      deps.ipcMain.removeHandler("passwords:add");
      deps.ipcMain.removeHandler("passwords:update");
      deps.ipcMain.removeHandler("passwords:remove");
      deps.ipcMain.removeHandler("passwords:never-remove");
      deps.ipcMain.removeHandler("logins:list");
      deps.ipcMain.removeHandler("logins:add");
      docWindows.clear();
      attached.clear();
    },
  };
}

export type PasswordsService = ReturnType<typeof createPasswordsService>;
