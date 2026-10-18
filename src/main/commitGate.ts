// Commit gate of a browser tab: resolves once the tab has a committed document.
//
// Why: `Emulation.*` CDP on a webContents that never committed a document
// segfaults the Electron 43 main process, and most other CDP commands are
// only answered after the first commit. So awaited, page-state CDP waits on
// `ensure()` first. The gate never awaits a CDP reply (that would deadlock);
// it only looks at navigation events, which the caller forwards in.
//
// `ensure()` ONLY WAITS. It never loads anything: loading the placeholder from
// there cancelled a navigation its caller had just started. The hidden
// `about:blank` placeholder is loaded in exactly two places, both by the owner
// of the tab: `startPlaceholderIfIdle()` shortly after a blank tab is created, and, by
// itself, when the tab's first navigation was aborted with no commit (HTTP
// 204, a download: only `did-stop-loading` fires) and nothing else is loading.
//
// A "commit" is `did-navigate` (main frame) or `dom-ready`. `dom-ready` is
// needed because a failed load commits an error page WITHOUT `did-navigate`
// (verified: connection refused emits did-fail-load, dom-ready, no
// did-navigate). A renderer crash resets the commit: the next Emulation.*
// waits for a fresh one.
// Pure: no Electron import, so it is unit-tested with fake events.

/** Placeholder document the gate loads into a tab that has nothing to commit. */
export const BLANK_DOCUMENT_URL = "about:blank";

export const COMMIT_TIMEOUT_MS = 10_000;
/** A wait is bounded even while a navigation keeps the tab "loading". */
const MAX_WAIT_FACTOR = 6;
const MAX_ABORT_PLACEHOLDER_LOADS = 3;
/** A requested placeholder whose navigation never starts is forgotten after this long. */
export const PLACEHOLDER_START_TIMEOUT_MS = 2_000;

export interface EnsureOptions {
  /**
   * A short, hard bound for this wait: it neither extends while a navigation
   * keeps the tab loading nor outlasts `timeoutMs`. Default: the gate's quiet
   * timeout, extended up to its hard cap while a load is in flight.
   */
  timeoutMs?: number;
}

export interface CommitGateDeps {
  isDestroyed(): boolean;
  isLoading(): boolean;
  /** Starts loading BLANK_DOCUMENT_URL. A rejection (abort, supersede) is ignored. */
  loadPlaceholder(): Promise<unknown>;
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

export interface CommitGate {
  /** Waits for a committed document; rejects after a quiet timeout or on a destroyed tab. Loads nothing. */
  ensure(opts?: EnsureOptions): Promise<void>;
  /** A document is committed right now (the placeholder counts). False before the first commit and after a renderer crash. */
  hasDocument(): boolean;
  /**
   * The owner is about to supersede an in-flight placeholder (it calls
   * `webContents.stop()` and loads a real URL): forget the request, and do not
   * treat the stop's `did-stop-loading` as an aborted first navigation.
   */
  cancelPlaceholder(): void;
  /**
   * Loads the placeholder into a blank tab (not awaited), unless the tab has
   * meanwhile started a navigation of its own or committed something. The
   * owner calls it a moment after creation, not in the same tick: a caller
   * that creates a tab and loads a URL straight away must not race it.
   */
  startPlaceholderIfIdle(): void;
  /** Main-frame, cross-document `did-start-navigation`. */
  onStartNavigation(url: string): void;
  /** Redirect or `did-start-loading`: the load is alive, extend the timeout. */
  onProgress(): void;
  /** Main-frame `did-navigate`. */
  onNavigated(url: string): void;
  /** `dom-ready` of the main frame. */
  onDomReady(): void;
  /** `did-stop-loading`. */
  onStopLoading(): void;
  /** `render-process-gone`: the document is gone. */
  onRendererGone(): void;
  /** `destroyed`. */
  onDestroyed(): void;
  /**
   * True when the most recent `onDomReady` was the placeholder's own. A caller
   * that arms "wait for dom-ready, then loadURL" (the agent's `open`) must skip
   * it, or the late placeholder dom-ready answers for the page it is loading.
   */
  lastDomReadyWasPlaceholder(): boolean;
  /** Exact: the document shown right now is the placeholder this gate loaded. */
  isPlaceholderShown(): boolean;
  /** A real page sits in front of the placeholder's history entry: remove it, then call `placeholderEntryRemoved`. */
  hasStalePlaceholderEntry(): boolean;
  placeholderEntryRemoved(): void;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: unknown;
  startedAt: number;
  /** Quiet timeout of this wait. */
  timeoutMs: number;
  /** Hard cap: a re-arm never extends past startedAt + capMs. */
  capMs: number;
}

export function createCommitGate(deps: CommitGateDeps): CommitGate {
  const timeoutMs = deps.timeoutMs ?? COMMIT_TIMEOUT_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = deps.now ?? (() => Date.now());
  let committed = false;
  // A document was EVER committed. Unlike `committed` a renderer crash keeps it:
  // after a crash the user's page and URL are still the tab's, so an aborted
  // reload must never be answered with the placeholder.
  let everCommitted = false;
  // The placeholder was cancelled by its owner: the did-stop-loading its stop()
  // causes is not an aborted first navigation. Cleared by the next navigation.
  let suppressAbortLoad = false;
  let placeholderRequestId = 0;
  let placeholderStartTimer: unknown;
  // The placeholder committed but its dom-ready has not fired. Resolving now
  // would let a following `open` take that late dom-ready for its own.
  let placeholderDomPending = false;
  // loadPlaceholder() was called and its navigation has not started / been superseded.
  let placeholderRequested = false;
  // The navigation in flight is the placeholder's.
  let placeholderNavigating = false;
  let showingPlaceholder = false;
  let lastDomWasPlaceholder = false;
  let navigationStarted = false;
  let placeholderEntry = false;
  let abortLoads = 0;
  let destroyed = false;
  let waiters: Waiter[] = [];

  const drain = (fn: (w: Waiter) => void) => {
    const list = waiters;
    waiters = [];
    for (const w of list) {
      clearTimer(w.timer);
      fn(w);
    }
  };
  const settle = () => {
    if (committed && !placeholderDomPending) drain((w) => w.resolve());
  };
  const loadPlaceholder = () => {
    if (destroyed || deps.isDestroyed()) return;
    placeholderRequested = true;
    placeholderNavigating = false;
    // A request that never turns into a navigation (the load threw, was rejected before it
    // started, or nothing followed) must not stay armed: it would mask a later genuine about:blank.
    const id = ++placeholderRequestId;
    const forget = () => {
      if (id !== placeholderRequestId || !placeholderRequested) return;
      placeholderRequested = false;
    };
    clearPlaceholderTimer();
    placeholderStartTimer = setTimer(forget, PLACEHOLDER_START_TIMEOUT_MS);
    try {
      deps.loadPlaceholder().catch(forget);
    } catch {
      /* a destroyed webContents throws synchronously */
      forget();
    }
  };
  const clearPlaceholderTimer = () => {
    if (placeholderStartTimer !== undefined) clearTimer(placeholderStartTimer);
    placeholderStartTimer = undefined;
  };
  const arm = (w: Waiter) => {
    clearTimer(w.timer);
    const remaining = Math.max(0, w.capMs - (now() - w.startedAt));
    w.timer = setTimer(() => {
      // Quiet for the whole timeout. A load still in flight that keeps no events coming gets
      // more time, up to the hard cap (which a re-arm never extends).
      if (deps.isLoading() && now() - w.startedAt < w.capMs) return arm(w);
      waiters = waiters.filter((x) => x !== w);
      w.reject(new Error(`The tab did not load a document within ${Math.round(w.timeoutMs / 1000)} s.`));
    }, Math.min(w.timeoutMs, remaining));
  };

  return {
    ensure(opts) {
      if (destroyed || deps.isDestroyed()) return Promise.reject(new Error("The tab was closed."));
      if (committed && !placeholderDomPending) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const short = opts?.timeoutMs;
        const waiter: Waiter = {
          resolve,
          reject,
          timer: undefined,
          startedAt: now(),
          timeoutMs: short ?? timeoutMs,
          capMs: short ?? timeoutMs * MAX_WAIT_FACTOR,
        };
        arm(waiter);
        waiters.push(waiter);
      });
    },
    hasDocument: () => committed,
    cancelPlaceholder() {
      placeholderRequestId += 1;
      clearPlaceholderTimer();
      placeholderRequested = false;
      placeholderNavigating = false;
      suppressAbortLoad = true;
    },
    startPlaceholderIfIdle() {
      if (committed || navigationStarted || deps.isLoading()) return;
      loadPlaceholder();
    },
    onStartNavigation(url) {
      for (const w of waiters) arm(w);
      if (!placeholderRequested) navigationStarted = true;
      clearPlaceholderTimer();
      // Also a reload of the placeholder itself (the viewport menu reloads after a UA change).
      if (url === BLANK_DOCUMENT_URL && (placeholderRequested || showingPlaceholder)) {
        placeholderRequested = false;
        placeholderNavigating = true;
      } else {
        placeholderRequested = false;
        placeholderNavigating = false;
        suppressAbortLoad = false;
        // A real navigation replaced a placeholder whose dom-ready never came: the next
        // dom-ready is this document's, not the placeholder's.
        if (placeholderDomPending || showingPlaceholder) {
          placeholderDomPending = false;
          showingPlaceholder = false;
          settle();
        }
      }
    },
    onProgress() {
      for (const w of waiters) arm(w);
    },
    onNavigated(url) {
      committed = true;
      everCommitted = true;
      suppressAbortLoad = false;
      abortLoads = 0;
      if (placeholderNavigating && url === BLANK_DOCUMENT_URL) {
        showingPlaceholder = true;
        placeholderDomPending = true;
        placeholderEntry = true;
      } else {
        showingPlaceholder = false;
        placeholderDomPending = false;
      }
      placeholderNavigating = false;
      settle();
    },
    onDomReady() {
      committed = true;
      everCommitted = true;
      abortLoads = 0;
      // A dom-ready the placeholder does not own belongs to an error page, which commits without did-navigate.
      lastDomWasPlaceholder = placeholderDomPending;
      if (!placeholderDomPending) showingPlaceholder = false;
      placeholderDomPending = false;
      settle();
    },
    onStopLoading() {
      // Only a tab that never committed a document gets the placeholder. After a renderer
      // crash the page and URL are the user's: wait for the next real commit (a reload).
      if (committed || everCommitted || suppressAbortLoad || deps.isLoading() || destroyed) return;
      // The first navigation was aborted (204, download) and nothing else is loading.
      if (abortLoads >= MAX_ABORT_PLACEHOLDER_LOADS) return;
      abortLoads += 1;
      loadPlaceholder();
    },
    onRendererGone() {
      committed = false;
      showingPlaceholder = false;
      placeholderDomPending = false;
      placeholderRequested = false;
      placeholderNavigating = false;
      abortLoads = 0;
      clearPlaceholderTimer();
    },
    onDestroyed() {
      destroyed = true;
      clearPlaceholderTimer();
      drain((w) => w.reject(new Error("The tab was closed.")));
    },
    lastDomReadyWasPlaceholder: () => lastDomWasPlaceholder,
    isPlaceholderShown: () => showingPlaceholder,
    hasStalePlaceholderEntry: () => placeholderEntry && !showingPlaceholder && committed,
    placeholderEntryRemoved() {
      placeholderEntry = false;
    },
  };
}
