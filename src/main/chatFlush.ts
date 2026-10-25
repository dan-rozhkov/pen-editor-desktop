/**
 * Flush handshake of chat storage (`chats:*`), the agent panel's twin of the canvas flush in canvasWriters.ts.
 * The panel page defines `window.penChatsFlush: () => Promise<void>`: it resolves after its pending chat saves got
 * their `chats:save` replies (at once when nothing is pending) and never rejects. Main runs this script in the
 * panel, awaits the returned promise (bounded by the shared `withTimeout`), and does so in parallel with the
 * canvas tab flush, in the same quit hold and before a window with a panel is closed.
 */
import { flushPage, FLUSH_TIMEOUT_MS, type CloseFlushPort } from "./canvasWriters";

export const CHATS_FLUSH_SCRIPT = "typeof window.penChatsFlush === 'function' ? window.penChatsFlush() : undefined";

/** Runs the chat flush handshake in a panel page, bounded. Never rejects. */
export function flushPanelChats(port: Pick<CloseFlushPort, "isDestroyed" | "runInPage">, timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> {
  return flushPage(port, timeoutMs, CHATS_FLUSH_SCRIPT);
}

export interface QuitFlushParts {
  /** Canvas tabs in any window, or a tab close still flushing. */
  hasCanvasWork(): boolean;
  /** Number of agent panels that can hold unsaved chats. */
  panelCount(): number;
  flushCanvasTabs(): Promise<unknown>;
  flushPanels(): Promise<unknown>;
}

/** The quit hold covers canvas tabs AND agent panels. */
export function hasQuitWork(parts: Pick<QuitFlushParts, "hasCanvasWork" | "panelCount">): boolean {
  return parts.hasCanvasWork() || parts.panelCount() > 0;
}

/** Flushes canvas tabs and chat panels in parallel; one failing never blocks the other. Never rejects. */
export async function flushQuitWork(parts: Pick<QuitFlushParts, "flushCanvasTabs" | "flushPanels">): Promise<void> {
  const run = (f: () => Promise<unknown>): Promise<unknown> => {
    try {
      return f();
    } catch (err) {
      return Promise.reject(err);
    }
  };
  await Promise.allSettled([run(parts.flushCanvasTabs), run(parts.flushPanels)]);
}
