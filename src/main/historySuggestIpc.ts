import type { HistoryEntry } from "./browser/historyStore";
import { inlineCompletion, suggest, type SuggestItem } from "./browser/historySuggest";

/** The longest query the address-bar suggestion channel answers. */
export const MAX_SUGGEST_QUERY = 2048;

export interface SuggestReply {
  items: SuggestItem[];
  inline: string | null;
}

export interface SuggestIpcDeps {
  /** The real `ipcMain`, narrowed to `handle` / `removeHandler`. */
  ipcMain: { handle(channel: string, listener: (event: { sender: { id: number } }, ...args: unknown[]) => unknown): void; removeHandler(channel: string): void };
  store: { list(): readonly HistoryEntry[] };
  /** True when `senderId` is the tab bar view of a live main window. */
  isTabbar(senderId: number): boolean;
  now?: () => number;
}

const EMPTY: SuggestReply = { items: [], inline: null };

/**
 * `history:suggest` (tab bar -> main, invoke). `ipcMain.handle` is process-global, so it is registered
 * once for the whole app; the sender check covers every window's tab bar. Returns the unregister function.
 */
export function registerHistorySuggest(deps: SuggestIpcDeps): () => void {
  const now = deps.now ?? Date.now;
  deps.ipcMain.handle("history:suggest", (e, payload): SuggestReply => {
    if (!deps.isTabbar(e.sender.id)) return EMPTY;
    const q = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>).query : undefined;
    if (typeof q !== "string" || q.length > MAX_SUGGEST_QUERY) return EMPTY;
    const items = suggest(deps.store.list(), q, now());
    return { items, inline: q ? inlineCompletion(items, q) : null };
  });
  return () => deps.ipcMain.removeHandler("history:suggest");
}
