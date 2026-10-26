// Ad and tracker blocking for the shared built-in browser partition. Decisions only: the Electron
// session, the blocker library and the disk are injected (index.ts is the glue). Network blocking
// ONLY: the library's `enableBlockingInSession` registers a preload script and IPC into pages, and
// browser tabs stay preload-free, so it is never called.

/** The one partition that is filtered. Isolated QA partitions (`qa-*`) and the default (editor) session never are. */
export const AD_BLOCK_PARTITION = "persist:penbrowser";
export const AD_BLOCK_CACHE_FILE = "adblock-engine.bin";

export function isAdBlockPartition(partition: string | undefined): boolean {
  return partition === AD_BLOCK_PARTITION;
}

/** The slice of Electron's `OnBeforeRequestListenerDetails` the decision reads. */
export interface RequestDetails {
  url: string;
  resourceType?: string;
}
export type RequestCallback = (response: { cancel?: boolean; redirectURL?: string }) => void;
export type RequestListener = (details: RequestDetails, callback: RequestCallback) => void;

/** The part of `ElectronBlocker` used: its own request matcher (it also passes main frames through). */
export interface BlockerPort {
  onBeforeRequest(details: never, callback: RequestCallback): void;
}

/** A navigation the user typed (main-frame document) is never blocked: only subresources are. */
export function isMainFrameRequest(details: RequestDetails): boolean {
  return details.resourceType === "mainFrame";
}

/**
 * The request listener for a loaded engine. Never leaves a request without an answer. While
 * `shouldBypass()` is true every request passes: a PageFixture applied on the shared browser may mock a
 * URL a filter list would cancel before CDP Fetch ever sees it.
 */
export function createRequestListener(blocker: BlockerPort, shouldBypass: () => boolean = () => false): RequestListener {
  return (details, callback) => {
    let bypass = false;
    try {
      bypass = shouldBypass();
    } catch {
      // a broken probe must not stop blocking
    }
    if (bypass || isMainFrameRequest(details)) {
      callback({});
      return;
    }
    try {
      blocker.onBeforeRequest(details as never, callback);
    } catch {
      callback({});
    }
  };
}

/** `session.webRequest`, narrowed. `null` removes the listener (Electron keeps only one per event). */
export interface WebRequestPort {
  onBeforeRequest(filter: { urls: string[] }, listener: RequestListener | null): void;
  onBeforeRequest(listener: null): void;
}

export interface AdBlockController {
  /** The engine finished loading (or null: none). */
  setEngine(blocker: BlockerPort | null): void;
  setEnabled(enabled: boolean): void;
  /** True while the request listener is registered. */
  isActive(): boolean;
}

/**
 * Registers the listener only while the setting is on AND an engine is loaded. A partition other than
 * `persist:penbrowser` gets a controller that never registers anything.
 */
export function createAdBlockController(deps: { partition: string; webRequest: WebRequestPort; shouldBypass?: () => boolean }): AdBlockController {
  const allowed = isAdBlockPartition(deps.partition);
  let blocker: BlockerPort | null = null;
  let enabled = false;
  let active = false;
  const sync = () => {
    const want = allowed && enabled && blocker !== null;
    if (want) {
      // Re-register on engine change: the listener closes over the blocker.
      deps.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, createRequestListener(blocker as BlockerPort, deps.shouldBypass));
      active = true;
    } else if (active) {
      deps.webRequest.onBeforeRequest(null);
      active = false;
    }
  };
  return {
    setEngine(b) {
      blocker = b;
      sync();
    },
    setEnabled(e) {
      if (enabled === e) return;
      enabled = e;
      sync();
    },
    isActive: () => active,
  };
}

/** What one window says about fixtures on the shared browser. */
export interface FixtureBypassState {
  /** When the window's applied fixture started to apply (ms), or null when none is applied. */
  fixtureSince: number | null;
  /** A release of a shared fixture is running (orphan or explicit). */
  releasing: boolean;
}

/** A fixture counts for at most this long since its apply started: one that is never released must not disable blocking forever. */
export const FIXTURE_BYPASS_MAX_MS = 15 * 60 * 1000;

/** Counts the windows that have a fixture on the shared browser. Each window lends a probe; any true = bypass. */
export interface FixtureBypassRegistry {
  /** Adds a window's fixture probe. Returns the remover. */
  register(probe: () => FixtureBypassState): () => void;
  shouldBypass(): boolean;
}

export function createFixtureBypassRegistry(opts: { now?: () => number; maxMs?: number } = {}): FixtureBypassRegistry {
  const now = opts.now ?? Date.now;
  const maxMs = opts.maxMs ?? FIXTURE_BYPASS_MAX_MS;
  const probes = new Set<() => FixtureBypassState>();
  return {
    register(probe) {
      probes.add(probe);
      return () => void probes.delete(probe);
    },
    shouldBypass() {
      for (const probe of probes) {
        try {
          const state = probe();
          // A release in flight always counts: the fixture's mocks are still being removed.
          if (state.releasing) return true;
          if (state.fixtureSince !== null && now() - state.fixtureSince < maxMs) return true;
        } catch {
          // a broken probe counts as not active
        }
      }
      return false;
    },
  };
}

/**
 * Resolves when every promise `pending()` returns (also ones added meanwhile) has settled, or after `timeoutMs`
 * (a release that hangs must not keep a window's probe forever). Never rejects. The timer is unref'd.
 */
export async function awaitSettled(pending: () => Iterable<Promise<unknown>>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  const drain = async (): Promise<void> => {
    for (let list = [...pending()]; list.length > 0; list = [...pending()]) await Promise.allSettled(list);
  };
  try {
    await Promise.race([drain(), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Requires a module and restores an env var to its previous value right after (deleted if it was unset).
 * `@ghostery/adblocker-electron` sets `ELECTRON_DISABLE_SECURITY_WARNINGS` when imported, which would
 * silence Electron's security warnings for the whole app.
 */
export function requireRestoringEnv<T>(env: NodeJS.ProcessEnv, key: string, load: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(env, key);
  const previous = env[key];
  try {
    return load();
  } finally {
    if (had) env[key] = previous;
    else delete env[key];
  }
}

export interface AdBlockFs {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Modification time of the file in ms, or null when it does not exist. */
  mtimeMs(path: string): Promise<number | null>;
}

export const ENGINE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const ENGINE_RETRY_MS = 10 * 60 * 1000;
/** Retry delays after a failed load: 10 min, 30 min, then every 60 min while blocking is on. */
export const ENGINE_RETRY_DELAYS_MS: readonly number[] = [ENGINE_RETRY_MS, 30 * 60 * 1000, 60 * 60 * 1000];
/** One engine build attempt (network) is cut off after this long. */
export const ENGINE_LOAD_TIMEOUT_MS = 30 * 1000;
/** While blocking is on, the engine age is checked this often. */
export const ENGINE_REFRESH_CHECK_MS = 24 * 60 * 60 * 1000;

type Caching = { path: string; read: (p: string) => Promise<Uint8Array>; write: (p: string, d: Uint8Array) => Promise<void> };

export interface LoadEngineDeps<B> {
  /** Builds an engine, e.g. `ElectronBlocker.fromPrebuiltAdsAndTracking(net.fetch, caching)`. */
  create(caching: Caching): Promise<B>;
  cachePath: string;
  fs: AdBlockFs;
  now?: () => number;
  /** Failure reports (the manager de-duplicates a streak of them). */
  log?: (message: string, err: unknown) => void;
  /** Cut-off of one `create` attempt. Default 30 s. */
  timeoutMs?: number;
  /**
   * Rebuild from the network without reading the cache, and without falling back to it: a failure yields null
   * (the caller keeps the engine it has). Used by the background refresh.
   */
  refresh?: boolean;
}

/** True when the cache file exists and is older than 7 days (the engine on disk is as old as its file). */
export async function isAdBlockCacheStale(deps: { fs: AdBlockFs; cachePath: string; now?: () => number }): Promise<boolean> {
  try {
    const mtime = await deps.fs.mtimeMs(deps.cachePath);
    return mtime !== null && (deps.now ?? Date.now)() - mtime > ENGINE_CACHE_MAX_AGE_MS;
  } catch {
    return false;
  }
}

/** Rejects when `promise` has not settled after `ms`. The late result is ignored. The timer is cleared. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Loads the engine once. A missing or corrupt cache is not an error (the library falls back to the lists
 * and rewrites it); a failed cache write is ignored. A cache file older than 7 days is not read: the
 * engine is built from the network (and the cache rewritten); if that fails the old cache is used. Each
 * build attempt is cut off after 30 s, so a hung network never keeps the load pending. A failed load is
 * reported through `log` and yields null: the browser works unfiltered.
 */
export async function loadAdBlockEngine<B>(deps: LoadEngineDeps<B>): Promise<B | null> {
  const log = deps.log ?? ((m, e) => console.error(m, e));
  const timeoutMs = deps.timeoutMs ?? ENGINE_LOAD_TIMEOUT_MS;
  const attempt = (caching: Caching): Promise<B> => withTimeout(deps.create(caching), timeoutMs, "engine build");
  const caching = (readable: boolean): Caching => ({
    path: deps.cachePath,
    read: readable ? (p) => deps.fs.readFile(p) : () => Promise.reject(new Error("cache ignored: stale")),
    write: async (p, d) => {
      try {
        await deps.fs.writeFile(p, d);
      } catch {
        // the cache is an optimisation
      }
    },
  });
  if (deps.refresh) {
    try {
      return await attempt(caching(false));
    } catch (err) {
      log("[adblock] refresh failed; keeping the current engine", err);
      return null;
    }
  }
  const stale = await isAdBlockCacheStale(deps);
  try {
    if (stale) {
      try {
        return await attempt(caching(false));
      } catch (err) {
        // offline with an old cache: an old filter list beats none
        log("[adblock] refresh failed; using the old cache", err);
      }
    }
    return await attempt(caching(true));
  } catch (err) {
    log("[adblock] engine load failed; the browser runs without blocking", err);
    return null;
  }
}

export interface EngineManagerDeps<B> {
  /** Loads (or builds) the engine. Failures are reported through `report` and yield null. */
  load(report: (message: string, err: unknown) => void): Promise<B | null>;
  /** True when the loaded engine is older than 7 days (the cache file's age). Without it there is no refresh. */
  isStale?(): Promise<boolean>;
  /** Rebuilds from the network. Failures are reported through `report` and yield null (the old engine stays). */
  refresh?(report: (message: string, err: unknown) => void): Promise<B | null>;
  onEngine(engine: B): void;
  isEnabled(): boolean;
  now?: () => number;
  /** Returns a cancel function. The default timer is unref'd. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Delay before the n-th retry (the last one repeats). Default 10 min, 30 min, 60 min. */
  retryDelaysMs?: readonly number[];
  refreshCheckMs?: number;
  /** Where the (de-duplicated) failure line goes. Default `console.error`, one line. */
  log?: (line: string) => void;
}

export interface EngineManager {
  /** Starts a load when none is running or done, and, after a failure, only when its backoff has passed. */
  ensure(): void;
  hasEngine(): boolean;
  dispose(): void;
}

function oneLine(message: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `${message}: ${detail}`.replace(/\s+/g, " ");
}

/**
 * Keeps one engine loaded while blocking is on. A failed load is retried after 10 min, then 30 min, then every
 * 60 min (on the next `ensure()` or from an unref'd timer). Only the FIRST failure of a streak is logged; a
 * success ends the streak. Every 24 h the engine age is checked: older than 7 days, it is rebuilt from the
 * network in the background and swapped in on success (the old one stays on failure).
 */
export function createEngineManager<B>(deps: EngineManagerDeps<B>): EngineManager {
  const now = deps.now ?? Date.now;
  const delays = deps.retryDelaysMs && deps.retryDelaysMs.length > 0 ? deps.retryDelaysMs : ENGINE_RETRY_DELAYS_MS;
  const refreshCheckMs = deps.refreshCheckMs ?? ENGINE_REFRESH_CHECK_MS;
  const writeLine = deps.log ?? ((line: string) => console.error(line));
  const setTimer =
    deps.setTimer ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return () => clearTimeout(t);
    });
  let loaded = false;
  let loading = false;
  let refreshing = false;
  let failures = 0;
  let failedAt: number | null = null;
  let cancelRetry: (() => void) | null = null;
  let cancelCheck: (() => void) | null = null;
  let disposed = false;
  let streakLogged = false;
  const report = (message: string, err: unknown): void => {
    if (streakLogged) return;
    streakLogged = true;
    writeLine(oneLine(message, err));
  };
  const retryDelay = (): number => delays[Math.min(Math.max(failures, 1), delays.length) - 1]!;

  const scheduleCheck = (): void => {
    if (disposed || !deps.isStale || !deps.refresh || cancelCheck) return;
    cancelCheck = setTimer(() => {
      cancelCheck = null;
      void check();
      scheduleCheck();
    }, refreshCheckMs);
  };
  const check = async (): Promise<void> => {
    if (disposed || !loaded || loading || refreshing || !deps.isEnabled() || !deps.isStale || !deps.refresh) return;
    refreshing = true;
    try {
      if (!(await deps.isStale())) return;
      const engine = await deps.refresh(report).catch((err: unknown) => {
        report("[adblock] refresh threw", err);
        return null;
      });
      if (disposed) return;
      if (engine) {
        streakLogged = false;
        deps.onEngine(engine);
      }
    } catch {
      // a broken age probe: try again at the next check
    } finally {
      refreshing = false;
    }
  };

  const ensure = (): void => {
    if (disposed || loaded || loading) return;
    if (failedAt !== null && now() - failedAt < retryDelay()) return;
    loading = true;
    cancelRetry?.();
    cancelRetry = null;
    void deps
      .load(report)
      .catch((err: unknown) => {
        report("[adblock] engine load threw", err);
        return null;
      })
      .then((engine) => {
        loading = false;
        if (disposed) return;
        if (engine) {
          loaded = true;
          failures = 0;
          failedAt = null;
          streakLogged = false;
          deps.onEngine(engine);
          scheduleCheck();
        } else {
          failures++;
          failedAt = now();
          cancelRetry = setTimer(() => {
            cancelRetry = null;
            if (deps.isEnabled()) ensure();
          }, retryDelay());
        }
      });
  };
  return {
    ensure,
    hasEngine: () => loaded,
    dispose() {
      disposed = true;
      cancelRetry?.();
      cancelRetry = null;
      cancelCheck?.();
      cancelCheck = null;
    },
  };
}
