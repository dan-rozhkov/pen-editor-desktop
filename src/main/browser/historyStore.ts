import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Browsing history of the built-in browser (design:
 * docs/superpowers/specs/2026-10-25-browser-history-design.md).
 *
 * Pure and Electron-free: the file system and the timer are injected, so the store is
 * unit-tested under plain Node. One entry per URL (hash removed), not one per visit:
 * `visitCount` and `lastVisitedAt` are all the address-bar ranking and the History tab need.
 * Writes are debounced and atomic (tmp + rename, owner-only); `flush()` runs on quit.
 */

export const HISTORY_FILE = "browser-history.json";
export const MAX_HISTORY_ENTRIES = 5000;
export const WRITE_DEBOUNCE_MS = 500;
/** Two visits to one URL closer than this are one navigation (redirect chains, reload bursts). */
export const VISIT_BURST_MS = 1000;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 300;

export interface HistoryEntry {
  /** The URL with its hash removed; also the entry's key. */
  url: string;
  title: string;
  visitCount: number;
  /** Epoch ms. */
  lastVisitedAt: number;
}

export interface HistoryFs {
  /** The file text, or null when the file does not exist. Any other failure throws. */
  read(filePath: string): Promise<string | null>;
  /** Throws when the write fails. */
  write(filePath: string, data: string): Promise<void>;
  /** Synchronous twin of `write` for the quit path (the process may exit before an async write lands). Throws when it fails. */
  writeSync(filePath: string, data: string): void;
}

const isErrno = (err: unknown, code: string): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;

/** Real fs: atomic replace (tmp + rename), owner-only permissions. */
export const nodeHistoryFs: HistoryFs = {
  async read(filePath) {
    try {
      return await fs.promises.readFile(filePath, "utf8");
    } catch (err) {
      if (isErrno(err, "ENOENT")) return null;
      throw err;
    }
  },
  async write(filePath, data) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, data, { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(tmp, filePath);
  },
  writeSync(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.sync.tmp`;
    fs.writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, filePath);
  },
};

/** Injectable timer (the write debounce); defaults to the global one. */
export interface HistoryTimers {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: HistoryTimers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The store key of a URL, or null when it is never recorded: http(s) only, hash removed,
 * no `user:pass@`, at most 2048 characters.
 */
export function historyKey(url: unknown): string | null {
  if (typeof url !== "string" || url.length > MAX_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  parsed.hash = "";
  const key = parsed.href;
  return key.length > MAX_URL_LENGTH ? null : key;
}

export interface HistoryStoreDeps {
  filePath: string;
  fs: HistoryFs;
  timers?: HistoryTimers;
}

function parseEntry(raw: unknown): HistoryEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { url, title, visitCount, lastVisitedAt } = raw as Record<string, unknown>;
  const key = historyKey(url);
  if (key === null || key !== url) return null;
  if (typeof title !== "string") return null;
  if (typeof visitCount !== "number" || !Number.isFinite(visitCount) || visitCount < 1) return null;
  if (typeof lastVisitedAt !== "number" || !Number.isFinite(lastVisitedAt)) return null;
  return { url: key, title: title.slice(0, MAX_TITLE_LENGTH), visitCount: Math.floor(visitCount), lastVisitedAt };
}

type HistoryOp =
  | { type: "visit"; key: string; now: number }
  | { type: "title"; key: string; title: string }
  | { type: "remove"; key: string }
  | { type: "clear" };

function enforceCap(entries: Map<string, HistoryEntry>): boolean {
  let dropped = false;
  while (entries.size > MAX_HISTORY_ENTRIES) {
    let oldest: HistoryEntry | null = null;
    for (const e of entries.values()) if (oldest === null || e.lastVisitedAt < oldest.lastVisitedAt) oldest = e;
    if (oldest === null) break;
    entries.delete(oldest.url);
    dropped = true;
  }
  return dropped;
}

/** Applies one mutation to `entries`. Returns true when something changed. */
function applyOp(entries: Map<string, HistoryEntry>, op: HistoryOp): boolean {
  switch (op.type) {
    case "visit": {
      const entry = entries.get(op.key);
      if (entry === undefined) {
        entries.set(op.key, { url: op.key, title: "", visitCount: 1, lastVisitedAt: op.now });
        enforceCap(entries);
      } else if (op.now - entry.lastVisitedAt >= 0 && op.now - entry.lastVisitedAt < VISIT_BURST_MS) {
        entry.lastVisitedAt = op.now; // a redirect or reload burst: one visit
      } else {
        entry.visitCount += 1;
        entry.lastVisitedAt = op.now;
      }
      return true;
    }
    case "title": {
      const entry = entries.get(op.key);
      if (entry === undefined || op.title === entry.title) return false;
      entry.title = op.title;
      return true;
    }
    case "remove":
      return entries.delete(op.key);
    case "clear":
      if (entries.size === 0) return false;
      entries.clear();
      return true;
  }
}

export function createHistoryStore(deps: HistoryStoreDeps) {
  const timers = deps.timers ?? realTimers;
  let entries = new Map<string, HistoryEntry>();
  const listeners = new Set<() => void>();
  let timer: unknown = null;
  let dirty = false;
  let writing: Promise<void> = Promise.resolve();
  /** True from `load()` being called until it finished. No write is scheduled or made meanwhile. */
  let loading = false;
  let loaded = false;
  /** Every mutation until the load finished, replayed in order onto the file's entries. */
  let pending: HistoryOp[] = [];

  const emit = (): void => {
    for (const cb of [...listeners]) cb();
  };

  const serialize = (): string => JSON.stringify({ version: 1, entries: [...entries.values()] });

  const writeNow = (): void => {
    if (!dirty || loading) return;
    dirty = false;
    const data = serialize();
    writing = writing.then(() => deps.fs.write(deps.filePath, data)).catch(() => undefined); // losing a write is fine: the next change writes again
  };

  /** Marks the data changed: schedules the debounced write (not while loading) and tells the listeners. */
  const changed = (): void => {
    dirty = true;
    if (timer === null && !loading) {
      timer = timers.setTimeout(() => {
        timer = null;
        writeNow();
      }, WRITE_DEBOUNCE_MS);
    }
    emit();
  };

  const run = (op: HistoryOp): boolean => {
    if (!loaded) pending.push(op);
    const did = applyOp(entries, op);
    if (did) changed();
    return did;
  };

  return {
    /**
     * Reads the file. A missing, unreadable or corrupt file loads as empty and is left alone until the
     * next change. Mutations made before the read finished are replayed, in order, onto the file's entries.
     */
    async load(): Promise<void> {
      loading = true;
      let list: HistoryEntry[] = [];
      try {
        const text = await deps.fs.read(deps.filePath);
        const parsed: unknown = text === null ? null : JSON.parse(text);
        const raw = typeof parsed === "object" && parsed !== null ? (parsed as { entries?: unknown }).entries : null;
        if (Array.isArray(raw)) list = raw.map(parseEntry).filter((e): e is HistoryEntry => e !== null);
      } catch {
        // unreadable or corrupt: start empty, do not overwrite until something changes
      }
      const merged = new Map<string, HistoryEntry>();
      for (const e of list) merged.set(e.url, e);
      const dropped = enforceCap(merged);
      const ops = pending;
      pending = [];
      for (const op of ops) applyOp(merged, op);
      entries = merged;
      loaded = true;
      loading = false;
      if (ops.length > 0 || dropped) changed();
      else if (list.length > 0) emit();
    },
    /** A top-level navigation to `url` finished. Returns false when the URL is not recordable. */
    recordVisit(url: string, now: number): boolean {
      const key = historyKey(url);
      if (key === null) return false;
      run({ type: "visit", key, now });
      return true;
    },
    /** Sets the title of an entry that exists (the page title arrives after the navigation). */
    setTitle(url: string, title: string): void {
      const key = historyKey(url);
      if (key === null) return;
      run({ type: "title", key, title: title.trim().slice(0, MAX_TITLE_LENGTH) });
    },
    remove(url: string): boolean {
      const key = historyKey(url);
      if (key === null) return false;
      return run({ type: "remove", key });
    },
    clear(): void {
      run({ type: "clear" });
    },
    /** Newest first; copies, so a caller cannot change the store. */
    list(): HistoryEntry[] {
      return [...entries.values()].sort((a, b) => b.lastVisitedAt - a.lastVisitedAt).map((e) => ({ ...e }));
    },
    /** Writes any pending change now and resolves once the file is on disk. Never writes before the load finished. */
    async flush(): Promise<void> {
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
      writeNow();
      await writing;
    },
    /** Quit path: writes a pending change synchronously. No-op when nothing is dirty or the load has not finished. */
    flushSync(): void {
      if (loading || !dirty) return;
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
      dirty = false;
      try {
        deps.fs.writeSync(deps.filePath, serialize());
      } catch {
        // best effort at quit
      }
    },
    /** Called after every change. Returns the function that withdraws the listener. */
    onChange(cb: () => void): () => void {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
}

export type HistoryStore = ReturnType<typeof createHistoryStore>;
