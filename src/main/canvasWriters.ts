/**
 * Process-level sender registry and flush handshake of canvas storage (`canvases:*`).
 *
 * Why not "is this a live tab of my window": the frontend's last autosave is flushed while the tab
 * closes (`window.penCanvasFlush`, see below). TabManager drops the tab entry BEFORE `webContents.close()` runs the
 * unload handlers, and on window close/quit the window's handlers are gone before `destroyAll()`.
 * So the final `canvases:save` must be accepted from a webContents that is no longer a live tab.
 * A webContents id therefore stays a writer for `graceMs` after its `destroyed` event
 * (the IPC message of the unload handler reaches main before or just after it). Ids are never reused
 * within a process, so a late entry cannot admit a stranger.
 */

export interface CanvasSenderRegistryOptions {
  /** How long an id stays valid after `release`. Default 10 s. */
  graceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface CanvasSenderRegistry {
  /** An editor (canvas) tab: may list, read, save and delete. Cancels a pending release. */
  addWriter(webContentsId: number): void;
  /** An agent panel: may list only. */
  addPanel(webContentsId: number): void;
  /** The webContents is destroyed: it stays valid for the grace period, then is forgotten. */
  release(webContentsId: number): void;
  isWriter(webContentsId: number): boolean;
  isPanel(webContentsId: number): boolean;
}

export const CANVAS_WRITER_GRACE_MS = 10_000;

export function createCanvasSenderRegistry(opts: CanvasSenderRegistryOptions = {}): CanvasSenderRegistry {
  const graceMs = opts.graceMs ?? CANVAS_WRITER_GRACE_MS;
  const setTimer =
    opts.setTimer ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.(); // never keeps the process alive
      return t;
    });
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const writers = new Set<number>();
  const panels = new Set<number>();
  const timers = new Map<number, unknown>();

  const cancel = (id: number) => {
    const t = timers.get(id);
    if (t !== undefined) clearTimer(t);
    timers.delete(id);
  };

  return {
    addWriter(id) {
      cancel(id);
      writers.add(id);
    },
    addPanel(id) {
      cancel(id);
      panels.add(id);
    },
    release(id) {
      cancel(id);
      if (!writers.has(id) && !panels.has(id)) return;
      timers.set(
        id,
        setTimer(() => {
          timers.delete(id);
          writers.delete(id);
          panels.delete(id);
        }, graceMs),
      );
    },
    isWriter: (id) => writers.has(id),
    isPanel: (id) => panels.has(id),
  };
}

/**
 * Flush handshake with the page. The editor page defines `window.penCanvasFlush: () => Promise<void>`:
 * it resolves after its pending canvas save got its `canvases:save` reply (at once when nothing is
 * pending) and never rejects. Main runs this script and awaits the returned promise (executeJavaScript
 * awaits it), so when it resolves the save is on disk or failed: no assumption about the order of the
 * script reply and the ipc dispatch.
 */
export const FLUSH_SCRIPT = "typeof window.penCanvasFlush === 'function' ? window.penCanvasFlush() : undefined";

/** Longest wait for one page flush. */
export const FLUSH_TIMEOUT_MS = 3000;

/** Resolves with `promise`'s value, or `undefined` after `ms` (the timer never keeps the process alive). Never rejects. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    (timer as NodeJS.Timeout).unref?.();
  });
  const safe = promise.then(
    (v) => v,
    () => undefined,
  );
  return Promise.race([safe, timeout]).finally(() => clearTimeout(timer));
}

export interface CloseFlushPort {
  isDestroyed(): boolean;
  /** Runs a script in the page; may reject or never settle. */
  runInPage(script: string): Promise<unknown>;
  close(): void;
}

export interface CloseFlushOptions {
  /** Longest wait for the page flush. Default 3 s. */
  flushTimeoutMs?: number;
  /** Script of the flush handshake. Default `FLUSH_SCRIPT` (canvas tabs); the agent panel passes the chat one. */
  script?: string;
}

/** Runs the flush handshake in the page, bounded. Never rejects. */
export async function flushPage(
  port: Pick<CloseFlushPort, "isDestroyed" | "runInPage">,
  timeoutMs = FLUSH_TIMEOUT_MS,
  script = FLUSH_SCRIPT,
): Promise<void> {
  if (port.isDestroyed()) return;
  let run: Promise<unknown>;
  try {
    run = port.runInPage(script);
  } catch {
    return;
  }
  await withTimeout(run, timeoutMs);
}

/** Tab closes that are still flushing (a quit waits for these too). */
const pendingCloses = new Set<Promise<void>>();
export function pendingCloseFlushes(): Promise<void>[] {
  return [...pendingCloses];
}

/** Flushes the page, closes. Always closes; never rejects. The flow is registered in `pendingCloseFlushes()`. */
export function flushThenClose(port: CloseFlushPort, opts: CloseFlushOptions = {}): Promise<void> {
  const flow = (async () => {
    try {
      await flushPage(port, opts.flushTimeoutMs, opts.script);
    } finally {
      try {
        if (!port.isDestroyed()) port.close();
      } catch (err) {
        console.error("canvas tab close failed", err);
      }
    }
  })();
  pendingCloses.add(flow);
  void flow.finally(() => pendingCloses.delete(flow));
  return flow;
}

/** The process-wide sender registry (window.ts registers views). */
export const canvasSenders = createCanvasSenderRegistry();
