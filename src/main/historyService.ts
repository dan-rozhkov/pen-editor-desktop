import type { ServiceEvent } from "./passwordsService";
import { historyKey, type HistoryEntry, type HistoryStore } from "./browser/historyStore";
import { filterEntries } from "./browser/historySuggest";
import type { UITheme } from "./tabManager";

/** The most rows one `history:list` answer carries. */
export const MAX_LISTED = 1000;
const MAX_QUERY_LENGTH = 200;
/** At most one `history:changed` per tab in this window (a page load records many titles/visits). */
export const CHANGED_COALESCE_MS = 250;

const DENIED = { ok: false } as const;

/** The slice of a `webContents` the service needs. Kept as a port so it is unit-tested without Electron. */
export interface HistoryContents {
  readonly id: number;
  isDestroyed(): boolean;
  /** `history:theme` (main -> the page). */
  sendTheme(payload: { theme: UITheme }): void;
  /** Optional: repaint the view's own background for `theme` (the page-less area before first paint). Called with every theme sent. */
  setBackground?(theme: UITheme): void;
  /** `history:changed` (main -> the page). */
  sendChanged(): void;
  /** Fires on every page load (`did-finish-load`): a fresh page needs the theme again. */
  onLoaded(cb: () => void): void;
  /** Fires once when the webContents is destroyed. */
  onDestroyed(cb: () => void): void;
}

/** What the owning window lends to its History tab. */
export interface HistoryPorts {
  /** The native "Clear history?" confirm on the owning window; true = go ahead. */
  confirmClear(): Promise<boolean>;
  /** Opens `url` (already checked http(s)) in a new, activated browser tab of the owning window. */
  openUrl(url: string): void;
}

export interface HistoryServiceDeps {
  /** The real `ipcMain`, narrowed to `handle` / `removeHandler`. Called once per channel, when the service is created (handlers are process-global). */
  ipcMain: { handle(channel: string, listener: (event: ServiceEvent, ...args: unknown[]) => unknown): void; removeHandler(channel: string): void };
  /** Injectable timer for the `history:changed` coalescing; defaults to the global one. */
  timers?: { setTimeout(cb: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
}

const payloadOf = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

/**
 * The browsing-history service behind the History tab. App-scoped like the passwords service: index.ts
 * makes one, so the four invoke/handle channels are registered exactly once. Each handler answers only
 * webContents that were `attach`ed, i.e. the History tabs of any main window; everything else gets
 * `{ ok: false }`. The window-specific actions (confirm, open a tab) come in through the ports each
 * `attach` lends, so a tab only ever acts on its own window.
 */
export function createHistoryService(store: HistoryStore, deps: HistoryServiceDeps) {
  const timers = deps.timers ?? {
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  interface Attached {
    contents: HistoryContents;
    owner: unknown;
    ports: HistoryPorts;
    lastTheme: UITheme | null;
    /** Set while the cool-down after a send runs. */
    cooling: unknown;
    /** A change arrived during the cool-down: one trailing send is owed. */
    trailing: boolean;
  }
  const attached = new Map<number, Attached>();

  const allowed = (e: ServiceEvent) => attached.get(e.sender.id);

  deps.ipcMain.handle("history:list", (e, payload): { entries: HistoryEntry[] } | typeof DENIED => {
    if (!allowed(e)) return DENIED;
    const q = payloadOf(payload).query;
    const query = typeof q === "string" ? q.slice(0, MAX_QUERY_LENGTH) : "";
    return { entries: filterEntries(store.list(), query).slice(0, MAX_LISTED) };
  });
  deps.ipcMain.handle("history:remove", (e, payload) => {
    if (!allowed(e)) return DENIED;
    const url = payloadOf(payload).url;
    if (historyKey(url) === null) return DENIED;
    store.remove(url as string);
    return { ok: true };
  });
  deps.ipcMain.handle("history:clear", async (e) => {
    const entry = allowed(e);
    if (!entry) return DENIED;
    let confirmed = false;
    try {
      confirmed = await entry.ports.confirmClear();
    } catch {
      return DENIED;
    }
    if (!confirmed) return { ok: false, cancelled: true };
    store.clear();
    return { ok: true };
  });
  deps.ipcMain.handle("history:open", (e, payload) => {
    const entry = allowed(e);
    if (!entry) return DENIED;
    const key = historyKey(payloadOf(payload).url);
    if (key === null) return DENIED;
    entry.ports.openUrl(key);
    return { ok: true };
  });

  // Every History tab re-reads the list when the data changes (including the sender, which has no local copy to patch).
  // Coalesced per tab: the first change sends at once, later ones inside the window collapse into one trailing send.
  const sendChanged = (entry: Attached): void => {
    if (entry.contents.isDestroyed()) return;
    if (entry.cooling !== null) {
      entry.trailing = true;
      return;
    }
    entry.contents.sendChanged();
    const cool = (): void => {
      entry.cooling = timers.setTimeout(() => {
        entry.cooling = null;
        if (entry.trailing) {
          entry.trailing = false;
          if (!entry.contents.isDestroyed()) {
            entry.contents.sendChanged();
            cool();
          }
        }
      }, CHANGED_COALESCE_MS);
    };
    cool();
  };
  const unsubscribe = store.onChange(() => {
    for (const entry of attached.values()) sendChanged(entry);
  });
  const detach = (id: number): void => {
    const entry = attached.get(id);
    if (entry?.cooling != null) timers.clearTimeout(entry.cooling);
    attached.delete(id);
  };

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
     * Marks a webContents as a History tab of the window `owner` (any key; the window's own object).
     * `currentTheme` is the theme that window's tab bar shows; it is pushed on every page load.
     */
    attach(contents: HistoryContents, owner: unknown, currentTheme: () => UITheme, ports: HistoryPorts): void {
      attached.set(contents.id, { contents, owner, ports, lastTheme: null, cooling: null, trailing: false });
      contents.onLoaded(() => sendTheme(contents.id, currentTheme(), true));
      contents.onDestroyed(() => detach(contents.id));
    },
    /** The window `owner`'s resolved theme changed: tell its History tabs (an unchanged value is not re-sent). */
    setTheme(owner: unknown, theme: UITheme): void {
      for (const [id, entry] of attached) if (entry.owner === owner) sendTheme(id, theme, false);
    },
    /** Removes the handlers and the store listener (app shutdown, or a test); the service is unusable afterwards. */
    dispose(): void {
      // Literals (not a loop over a list): test/ipcContract.test.ts scans the source for them.
      deps.ipcMain.removeHandler("history:list");
      deps.ipcMain.removeHandler("history:remove");
      deps.ipcMain.removeHandler("history:clear");
      deps.ipcMain.removeHandler("history:open");
      unsubscribe();
      for (const id of [...attached.keys()]) detach(id);
    },
  };
}

export type HistoryService = ReturnType<typeof createHistoryService>;
