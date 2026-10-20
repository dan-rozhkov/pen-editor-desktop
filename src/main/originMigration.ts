/**
 * One-time copy of the old editor origin's browser storage into the new one
 * (pen-editor-backend docs/superpowers/specs/2026-10-20-desktop-sign-in-design.md,
 * "Origin migration"). The desktop moved from pen-editor.onrender.com to
 * app.sideform.pro; localStorage and IndexedDB are per-origin, so the user's
 * markdown docs, `pen.userId`, share edit tokens, plugins and custom fonts would
 * otherwise stay behind.
 *
 * This file is Electron-free: the decision, the merge rules, the serialization
 * and the orchestration run against an injected `MigrationPort`.
 * originMigrationRunner.ts is the thin Electron glue (a hidden BrowserWindow).
 * Old data is never deleted.
 */

export const ORIGIN_MIGRATION_FILE = "origin-migration.json";
/** Overall budget for the whole migration, window creation included. Startup awaits it before the
 * main window exists, so it stays short; a miss only means "retry on the next launch". */
export const ORIGIN_MIGRATION_TIMEOUT_MS = 5_000;
/** The tiny local page the hidden window loads on each origin. The runner answers exactly these URLs
 * itself (no network), so the page really has the origin's storage but nothing can redirect or fail. */
export const MIGRATE_PATH = "/__sideform_migrate__";
export const MIGRATE_PAGE_HTML = "<!doctype html><meta charset=utf-8><title>migrate</title>";
export const migrateUrl = (origin: string): string => `${origin}${MIGRATE_PATH}`;

/** The IndexedDB layout the frontend creates (pen-editor src/utils/indexedDbStore.ts:
 * `indexedDB.open(dbName, 1)`, one store with `keyPath`; pluginDb.ts, customFontDb.ts). */
export interface IdbTarget {
  db: string;
  store: string;
  keyPath: string;
  version: number;
}
export const IDB_TARGETS: readonly IdbTarget[] = [
  { db: "pen-editor-plugins", store: "plugins", keyPath: "id", version: 1 },
  { db: "pen-editor-custom-fonts", store: "fonts", keyPath: "family", version: 1 },
];

// --- decision and flag file -------------------------------------------------

export interface MigrationFlag {
  from: string;
  to: string;
  done: true;
  doneAt: string;
  counts: MigrationCounts;
  note?: string;
  /** Terminal record: MAX_MIGRATION_ATTEMPTS failures in a row, retrying stops for good. */
  failed?: true;
  attempts?: number;
  lastError?: string;
}

/** After this many failed launches the migration gives up (a terminal `done: true, failed: true` record). */
export const MAX_MIGRATION_ATTEMPTS = 3;

export interface MigrationCounts {
  localStorage: number;
  plugins: number;
  fonts: number;
}

export interface MigrationFs {
  /** File text, or null when missing/unreadable. */
  read(p: string): string | null;
  write(p: string, text: string): void;
}

/** True when the flag text says `done` for exactly this from -> to pair. */
export function isMigrationDone(flagText: string | null, from: string, to: string): boolean {
  if (flagText === null) return false;
  try {
    const f = JSON.parse(flagText) as Partial<MigrationFlag> | null;
    return !!f && f.done === true && f.from === from && f.to === to;
  } catch {
    return false;
  }
}

/** Runs only for the default editor URL (no PEN_DESKTOP_URL override, which may point anywhere,
 * including at a dev origin that must never receive production data) and only until done. */
export function shouldRunOriginMigration(input: {
  /** `PEN_DESKTOP_URL` is set to a real value. */
  overridden: boolean;
  flagText: string | null;
  from: string;
  to: string;
}): boolean {
  if (input.overridden) return false;
  if (input.from === input.to) return false;
  return !isMigrationDone(input.flagText, input.from, input.to);
}

/** Failed attempts recorded so far for exactly this pair (a non-terminal record), else 0. */
export function priorAttempts(flagText: string | null, from: string, to: string): number {
  if (flagText === null) return 0;
  try {
    const f = JSON.parse(flagText) as { from?: unknown; to?: unknown; attempts?: unknown } | null;
    if (!f || f.from !== from || f.to !== to) return 0;
    return typeof f.attempts === "number" && Number.isInteger(f.attempts) && f.attempts > 0 ? f.attempts : 0;
  } catch {
    return 0;
  }
}

/** The record to write after a failed run: a counter below the cap, a terminal `done` record at the cap. */
export function failureFlagText(from: string, to: string, attempts: number, lastError: string, now: Date): string {
  if (attempts >= MAX_MIGRATION_ATTEMPTS) {
    const flag: MigrationFlag = { from, to, done: true, failed: true, doneAt: now.toISOString(), counts: { localStorage: 0, plugins: 0, fonts: 0 }, attempts, lastError };
    return JSON.stringify(flag, null, 2);
  }
  return JSON.stringify({ from, to, done: false, attempts, lastError, at: now.toISOString() }, null, 2);
}

export function migrationFlagText(from: string, to: string, counts: MigrationCounts, now: Date): string {
  const flag: MigrationFlag = { from, to, done: true, doneAt: now.toISOString(), counts };
  return JSON.stringify(flag, null, 2);
}

// --- snapshot and merge plan -------------------------------------------------

/** Values are in the tagged form (see PAGE_CODEC): ArrayBuffers are `{ "__ab": base64 }`. */
export interface IdbExport {
  db: string;
  store: string;
  keyPath: string;
  records: unknown[];
}
export interface OriginSnapshot {
  localStorage: Record<string, string>;
  idb: IdbExport[];
}
/** What the new origin already holds. IDB keys are the keyPath values of its records. */
export interface ExistingState {
  localStorageKeys: string[];
  /** Raw `pen.docs.index` of the new origin, null when absent. Optional for older callers. */
  docsIndex?: string | null;
  /** Raw `pen.userId` of the new origin, null when absent. */
  userId?: string | null;
  idb: { db: string; store: string; keys: unknown[] }[];
}
export interface MergePlan {
  localStorage: [string, string][];
  /** Keys of `localStorage` that are WRITTEN even when present on the new origin (see OVERWRITE_KEYS / DOCS_INDEX_KEY). */
  overwrite: string[];
  idb: IdbExport[];
  skipped: { localStorage: number; idb: number };
}

const keyId = (key: unknown): string => `${typeof key}:${String(key)}`;

/** The anonymous id. The new origin can only hold one if THIS desktop minted it on a launch whose
 * migration failed, so the old origin's id (the one the user's data and server records belong to) wins. */
export const USER_ID_KEY = "pen.userId";
/** The markdown docs index (pen-editor src/lib/docs/docStore.ts: a JSON array of `{id, title, updatedAt}`). */
export const DOCS_INDEX_KEY = "pen.docs.index";

/** Union of two docs-index texts by doc id; the NEW origin's entry wins on a duplicate id.
 * Null when `oldText` has nothing usable (then the new index stays as it is). */
export function mergeDocsIndex(oldText: string, newText: string | null | undefined): string | null {
  const parse = (t: string | null | undefined): { id: unknown }[] | null => {
    if (!t) return null;
    try {
      const v = JSON.parse(t) as unknown;
      return Array.isArray(v) ? (v.filter((e) => e !== null && typeof e === "object" && "id" in (e as object)) as { id: unknown }[]) : null;
    } catch {
      return null;
    }
  };
  const oldIdx = parse(oldText);
  if (!oldIdx) return null;
  const newIdx = parse(newText) ?? [];
  const have = new Set(newIdx.map((e) => keyId(e.id)));
  const extra = oldIdx.filter((e) => {
    if (have.has(keyId(e.id))) return false;
    have.add(keyId(e.id));
    return true;
  });
  return JSON.stringify([...newIdx, ...extra]);
}

/** Fill-only merge with two exceptions: `pen.userId` (old wins) and `pen.docs.index` (union by id,
 * new entry wins a duplicate). A localStorage key is otherwise written only when absent, an IndexedDB
 * record only when its key is absent. */
export function planMerge(snapshot: OriginSnapshot, existing: ExistingState): MergePlan {
  const haveLs = new Set(existing.localStorageKeys);
  const localStorage: [string, string][] = [];
  const overwrite: string[] = [];
  let skippedLs = 0;
  for (const [k, v] of Object.entries(snapshot.localStorage)) {
    if (k === USER_ID_KEY && haveLs.has(k)) {
      // Overwritten unless the new origin already holds the very same value.
      if (existing.userId === v) skippedLs++;
      else {
        localStorage.push([k, v]);
        overwrite.push(k);
      }
    } else if (k === DOCS_INDEX_KEY && haveLs.has(k)) {
      const merged = mergeDocsIndex(v, existing.docsIndex);
      if (merged === null || merged === existing.docsIndex) skippedLs++;
      else {
        localStorage.push([k, merged]);
        overwrite.push(k);
      }
    } else if (haveLs.has(k)) skippedLs++;
    else localStorage.push([k, v]);
  }
  let skippedIdb = 0;
  const idb: IdbExport[] = [];
  for (const exp of snapshot.idb) {
    const have = new Set((existing.idb.find((e) => e.db === exp.db && e.store === exp.store)?.keys ?? []).map(keyId));
    const records: unknown[] = [];
    for (const rec of exp.records) {
      const key = rec !== null && typeof rec === "object" ? (rec as Record<string, unknown>)[exp.keyPath] : undefined;
      // A record without a usable key could not have been stored by the frontend either.
      if (key === undefined || have.has(keyId(key))) {
        skippedIdb++;
        continue;
      }
      have.add(keyId(key)); // duplicates inside the export
      records.push(rec);
    }
    if (records.length > 0) idb.push({ ...exp, records });
  }
  return { localStorage, overwrite, idb, skipped: { localStorage: skippedLs, idb: skippedIdb } };
}

export function countsOf(plan: MergePlan): MigrationCounts {
  const n = (store: string) => plan.idb.filter((e) => e.store === store).reduce((s, e) => s + e.records.length, 0);
  return { localStorage: plan.localStorage.length, plugins: n("plugins"), fonts: n("fonts") };
}

// --- page-side code ----------------------------------------------------------

/**
 * The tagged (de)serialization that runs INSIDE the page (plain JS, no imports).
 * IndexedDB values may hold ArrayBuffers (custom font bytes), which JSON cannot
 * carry through executeJavaScript: `enc` turns them into `{ "__ab": base64 }`
 * (typed arrays Uint8Array into `{ "__u8": base64 }`), `dec` turns them back.
 * A record that natively has a lone `__ab`/`__u8` key would be misread; the
 * frontend writes none. `loadCodec()` evaluates this very string for unit tests,
 * so there is one implementation, not a TS copy of it.
 */
export const PAGE_CODEC = `
const b64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (str) => { const s = atob(str); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };
const enc = (v) => {
  if (v instanceof ArrayBuffer) return { __ab: b64(new Uint8Array(v)) };
  if (v instanceof Uint8Array) return { __u8: b64(v) };
  if (Array.isArray(v)) return v.map(enc);
  if (v !== null && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = enc(v[k]); return o; }
  return v;
};
const dec = (v) => {
  if (Array.isArray(v)) return v.map(dec);
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "__ab" && typeof v.__ab === "string") return unb64(v.__ab).buffer;
    if (keys.length === 1 && keys[0] === "__u8" && typeof v.__u8 === "string") return unb64(v.__u8);
    const o = {}; for (const k of keys) o[k] = dec(v[k]); return o;
  }
  return v;
};
`;

export function loadCodec(): { enc(v: unknown): unknown; dec(v: unknown): unknown } {
  return new Function(`${PAGE_CODEC}; return { enc, dec };`)() as { enc(v: unknown): unknown; dec(v: unknown): unknown };
}

const targetsLiteral = (): string => JSON.stringify(IDB_TARGETS);

/** Runs on the OLD origin. Never creates a database (checks `indexedDB.databases()` first). Returns a JSON string. */
export function exportScript(): string {
  return `(async () => {
${PAGE_CODEC}
const targets = ${targetsLiteral()};
const localStorageOut = {};
for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k !== null) localStorageOut[k] = localStorage.getItem(k); }
const known = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : [];
const idb = [];
for (const t of targets) {
  if (!known.includes(t.db)) continue;
  const db = await new Promise((res, rej) => { const r = indexedDB.open(t.db); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  try {
    if (!db.objectStoreNames.contains(t.store)) continue;
    const records = await new Promise((res, rej) => { const r = db.transaction(t.store, "readonly").objectStore(t.store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    idb.push({ db: t.db, store: t.store, keyPath: t.keyPath, records: records.map(enc) });
  } finally { db.close(); }
}
return JSON.stringify({ localStorage: localStorageOut, idb });
})()`;
}

const OPEN_DB = `(t) => new Promise((res, rej) => {
  const r = indexedDB.open(t.db, t.version);
  r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains(t.store)) db.createObjectStore(t.store, { keyPath: t.keyPath }); };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
})`;

/** Runs on the NEW origin: which keys already exist. Opens/creates the databases exactly like indexedDbStore.ts. */
export function existingScript(): string {
  return `(async () => {
const openDb = ${OPEN_DB};
const targets = ${targetsLiteral()};
const localStorageKeys = [];
for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k !== null) localStorageKeys.push(k); }
const idb = [];
for (const t of targets) {
  const db = await openDb(t);
  try {
    if (!db.objectStoreNames.contains(t.store)) throw new Error("store " + t.store + " is missing in " + t.db);
    const keys = await new Promise((res, rej) => { const r = db.transaction(t.store, "readonly").objectStore(t.store).getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    idb.push({ db: t.db, store: t.store, keys });
  } finally { db.close(); }
}
return JSON.stringify({ localStorageKeys, docsIndex: localStorage.getItem(${JSON.stringify(DOCS_INDEX_KEY)}), userId: localStorage.getItem(${JSON.stringify(USER_ID_KEY)}), idb });
})()`;
}

/** Runs on the NEW origin: writes the plan. `add` (not `put`) so an existing key can never be overwritten. */
export function applyScript(plan: MergePlan): string {
  return `(async () => {
${PAGE_CODEC}
const openDb = ${OPEN_DB};
const plan = ${JSON.stringify({ localStorage: plan.localStorage, overwrite: plan.overwrite, idb: plan.idb })};
const targets = ${targetsLiteral()};
for (const [k, v] of plan.localStorage) { if (plan.overwrite.includes(k) || localStorage.getItem(k) === null) localStorage.setItem(k, v); }
for (const exp of plan.idb) {
  const t = targets.find((x) => x.db === exp.db && x.store === exp.store);
  if (!t) continue;
  const db = await openDb(t);
  try {
    for (const rec of exp.records) {
      await new Promise((res) => {
        const tx = db.transaction(t.store, "readwrite");
        const r = tx.objectStore(t.store).add(dec(rec));
        r.onerror = (e) => { e.preventDefault(); res(); }; // ConstraintError: the key appeared meanwhile, keep it
        tx.oncomplete = () => res();
        tx.onabort = () => res();
      });
    }
  } finally { db.close(); }
}
return "ok";
})()`;
}

// --- orchestration -----------------------------------------------------------

export interface MigrationPort {
  /** Removes service workers and Cache Storage (nothing else) of these origins, so a legacy worker
   * cannot answer the migration page before the runner's protocol handler. Best effort: a rejection is ignored. */
  clearServiceWorkers(origins: string[]): Promise<void>;
  /** Loads `<origin>/__sideform_migrate__` (answered locally by the runner: the editor must not boot there). Rejects on a load failure. */
  load(url: string): Promise<void>;
  /** The URL the window is on right now (after redirects). */
  currentUrl(): string;
  /** executeJavaScript in the loaded page; resolves its return value. */
  run(script: string): Promise<unknown>;
  /** Closes the window. Idempotent. */
  dispose(): void;
}

export type MigrationOutcome =
  | { status: "done"; counts: MigrationCounts; skipped: MergePlan["skipped"] }
  | { status: "failed"; error: string }
  | { status: "timeout" };

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

const parseJson = (raw: unknown, what: string): unknown => {
  if (typeof raw !== "string") throw new Error(`${what}: unexpected result`);
  return JSON.parse(raw);
};

/** Never throws. The overall `timeoutMs` covers loads, scripts and window creation (in `makePort`);
 * on timeout the port is disposed, which also fails whatever is still pending. */
export async function runOriginMigration(opts: {
  from: string;
  to: string;
  makePort(): MigrationPort;
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): Promise<MigrationOutcome> {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let port: MigrationPort | null = null;
  let timedOut = false;
  let timer: unknown;

  const work = (async (): Promise<MigrationOutcome> => {
    const p = (port = opts.makePort());
    // The runner answers these URLs locally, so the window must land on exactly the origin asked for.
    // A mismatch is a bug (the handler is not in effect): fail without a done flag rather than export
    // from, or import into, the wrong origin.
    const loadOn = async (origin: string): Promise<void> => {
      await p.load(migrateUrl(origin));
      const actual = originOf(p.currentUrl());
      if (actual !== origin) throw new Error(`window is on ${actual}, expected ${origin}`);
    };
    await p.clearServiceWorkers([opts.from, opts.to]).catch(() => undefined);
    await loadOn(opts.from);
    const snapshot = parseJson(await port.run(exportScript()), "export") as OriginSnapshot;
    await loadOn(opts.to);
    const existing = parseJson(await port.run(existingScript()), "existing") as ExistingState;
    const plan = planMerge(snapshot, existing);
    if (plan.localStorage.length > 0 || plan.idb.length > 0) {
      const res = await port.run(applyScript(plan));
      if (res !== "ok") throw new Error("import: unexpected result");
    }
    return { status: "done", counts: countsOf(plan), skipped: plan.skipped };
  })().catch((err: unknown): MigrationOutcome => ({ status: "failed", error: err instanceof Error ? err.message : String(err) }));

  const deadline = new Promise<MigrationOutcome>((resolve) => {
    timer = setTimer(() => {
      timedOut = true;
      resolve({ status: "timeout" });
    }, opts.timeoutMs ?? ORIGIN_MIGRATION_TIMEOUT_MS);
  });

  try {
    const outcome = await Promise.race([work, deadline]);
    return timedOut ? { status: "timeout" } : outcome;
  } finally {
    clearTimer(timer);
    (port as MigrationPort | null)?.dispose();
  }
}

/** Reads the flag, decides, runs, and writes `done` on success. Never throws. A failure bumps an attempt
 * counter in the flag file; the MAX_MIGRATION_ATTEMPTS-th one writes a terminal record and retrying stops. */
export async function migrateIfNeeded(opts: {
  overridden: boolean;
  from: string;
  to: string;
  flagPath: string;
  fs: MigrationFs;
  makePort(): MigrationPort;
  now(): Date;
  log(message: string): void;
  timeoutMs?: number;
}): Promise<MigrationOutcome | "skipped"> {
  const flagText = opts.fs.read(opts.flagPath);
  if (!shouldRunOriginMigration({ overridden: opts.overridden, flagText, from: opts.from, to: opts.to })) return "skipped";
  const outcome = await runOriginMigration({ from: opts.from, to: opts.to, makePort: opts.makePort, timeoutMs: opts.timeoutMs });
  if (outcome.status === "done") {
    try {
      opts.fs.write(opts.flagPath, migrationFlagText(opts.from, opts.to, outcome.counts, opts.now()));
    } catch (err) {
      opts.log(`origin migration: could not write the done flag (it will run again): ${String(err)}`);
    }
    opts.log(`origin migration done: ${JSON.stringify(outcome.counts)} (skipped ${JSON.stringify(outcome.skipped)})`);
    return outcome;
  }
  const error = outcome.status === "timeout" ? "timeout" : outcome.error;
  const attempts = priorAttempts(flagText, opts.from, opts.to) + 1;
  try {
    opts.fs.write(opts.flagPath, failureFlagText(opts.from, opts.to, attempts, error, opts.now()));
  } catch (err) {
    opts.log(`origin migration: could not record the failed attempt: ${String(err)}`);
  }
  opts.log(
    attempts >= MAX_MIGRATION_ATTEMPTS
      ? `origin migration failed (${error}) ${attempts} times; giving up for good`
      : `origin migration ${outcome.status === "timeout" ? "timed out" : `failed (${error})`}; attempt ${attempts}/${MAX_MIGRATION_ATTEMPTS}, it will retry on the next launch`,
  );
  return outcome;
}
