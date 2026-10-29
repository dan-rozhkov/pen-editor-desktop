import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { isValidDocId } from "./config";
import { createKeyedChain, isObject, message, sweepStaleTmp } from "./storeUtils";

export { STALE_TMP_MS } from "./storeUtils";

/**
 * Local storage of the user's Markdown documents (the frontend's `/doc` surface):
 * `<root>/<id>.json`, one compact JSON file per document. The frontend keeps
 * localStorage as the working copy and mirrors every write here.
 *
 * Newer-rev-wins: a save whose `rev` is not above the stored one writes nothing.
 * The read-compare-write of one id runs on a per-id promise chain, so two
 * concurrent saves cannot both pass the check. Documents are user data and are
 * never pruned. Pure and Electron-free: the file system is a port (same shape as
 * traceStore.ts), so the store is unit-tested under plain Node.
 */

export const DOC_DIR = "documents";
/** Directory used while `PEN_DESKTOP_URL` overrides the editor: a dev frontend must never read or overwrite production documents. */
export const DEV_DOC_DIR = "documents-dev";

/** The documents directory name: `documents-dev` when the editor URL is overridden, else `documents`. */
export function docDirFor(overrideActive: boolean): string {
  return overrideActive ? DEV_DOC_DIR : DOC_DIR;
}
/** Tombstones live in one file next to the documents. The leading dot keeps it out of `FILE_NAME`, so `list` never reads it as a document. */
export const TOMBSTONE_FILE = ".deleted.json";
/**
 * Tombstones are never aged out: they are the only guard for a page copy that never heard about the
 * deletion. The set is capped instead; on write the oldest (`at`) entries beyond the cap are dropped.
 */
export const MAX_TOMBSTONES = 10_000;
export const MAX_DOC_TITLE_CHARS = 10_000;
export const MAX_DOC_MARKDOWN_BYTES = 5 * 1024 * 1024;

export interface StoredDoc {
  id: string;
  title: string;
  markdown: string;
  updatedAt: number;
  rev: number;
}

export interface DocFs {
  /** The file bytes, or null when the file does not exist (ENOENT only; any other failure rejects). */
  read(filePath: string): Promise<Buffer | null>;
  /** Creates parent directories; atomic replace (tmp + rename), mode 0o600. Rejects on failure. */
  write(filePath: string, data: Buffer): Promise<void>;
  /** Files (names, not paths, with mtime in ms) directly in `dir`. A missing `dir` gives []. */
  listFiles(dir: string): Promise<{ name: string; mtimeMs: number }[]>;
  /** Removes a file; a missing one is not an error. */
  remove(filePath: string): Promise<void>;
}

const isErrno = (err: unknown, code: string): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;

/** Real fs (fs.promises: nothing blocks the main process). */
export const nodeDocFs: DocFs = {
  async read(filePath) {
    try {
      return await fsp.readFile(filePath);
    } catch (err) {
      if (isErrno(err, "ENOENT")) return null;
      throw err;
    }
  },
  async write(filePath, data) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    // Unique per write: two writers never share a tmp path.
    const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await fsp.writeFile(tmp, data, { mode: 0o600 });
    await fsp.rename(tmp, filePath);
  },
  async listFiles(dir) {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const out: { name: string; mtimeMs: number }[] = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        try {
          out.push({ name: e.name, mtimeMs: (await fsp.stat(path.join(dir, e.name))).mtimeMs });
        } catch {
          // vanished between readdir and stat
        }
      }
      return out;
    } catch (err) {
      if (isErrno(err, "ENOENT")) return [];
      throw err;
    }
  },
  async remove(filePath) {
    await fsp.rm(filePath, { force: true });
  },
};

/** A deleted document: the rev it had when removed. A save at or below that rev is refused. */
export interface DocTombstone {
  id: string;
  rev: number;
}
export type DocListResult = { docs: StoredDoc[]; deleted: DocTombstone[] } | { error: string };
export type DocSaveResult = { ok: true; rev: number } | { ok: true; stale: true; rev: number } | { error: string };
export type DocRemoveResult = { ok: true } | { error: string };

export interface DocStore {
  /** Every valid stored document plus the tombstones of deleted ones. Unreadable or invalid files are skipped and logged. Never throws. */
  list(): Promise<DocListResult>;
  /** Validates and stores a document (newer rev wins). Never throws. */
  save(doc: unknown): Promise<DocSaveResult>;
  /** Deletes a document and records a tombstone (only when a document was stored); a missing one is fine. Never throws. */
  remove(id: unknown): Promise<DocRemoveResult>;
}

export interface DocStoreOptions {
  /** Absolute path of the documents directory (`<userData>/documents`). */
  rootDir: string;
  fs: DocFs;
  /** Clock for sweeping stale temp files. Default Date.now. */
  now?: () => number;
}

const FILE_NAME = /^([A-Za-z0-9_-]{1,64})\.json$/;

/** The five contract fields of a valid document, or an error. Anything else on the input is dropped. */
export function parseStoredDoc(raw: unknown): { doc: StoredDoc } | { error: string } {
  if (!isObject(raw)) return { error: "invalid document" };
  const { id, title, markdown, updatedAt, rev } = raw;
  if (!isValidDocId(id)) return { error: "invalid document id" };
  if (typeof title !== "string" || title.length > MAX_DOC_TITLE_CHARS) return { error: "invalid title" };
  // A string of n UTF-16 units is at most 3n bytes: the cheap bound skips the byte count for small texts.
  if (typeof markdown !== "string" || (markdown.length * 3 > MAX_DOC_MARKDOWN_BYTES && Buffer.byteLength(markdown, "utf8") > MAX_DOC_MARKDOWN_BYTES)) {
    return { error: "markdown too large" };
  }
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return { error: "invalid updatedAt" };
  if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 1) return { error: "invalid rev" };
  return { doc: { id, title, markdown, updatedAt, rev } };
}

export function createDocStore(opts: DocStoreOptions): DocStore {
  const { rootDir, fs: io } = opts;
  const now = opts.now ?? Date.now;
  // Last known stored rev per id. This process is the only writer, so it stays true;
  // absent or corrupt files are never cached.
  const revs = new Map<string, number>();
  const fileOf = (id: string) => path.join(rootDir, `${id}.json`);
  const serialized = createKeyedChain();
  const tombFile = path.join(rootDir, TOMBSTONE_FILE);
  // The tombstone file is one shared read-modify-write, so it has its own chain (the key cannot be a doc id).
  const TOMB_KEY = "\0tombstones";
  let tombs: Map<string, { rev: number; at: number }> | null = null;

  /**
   * Only call inside `serialized(TOMB_KEY, ...)`. A missing file or unusable content (bad JSON, wrong
   * shape) is an empty set, cached. Any other read error (EACCES, EIO, EMFILE...) is transient: it is NOT
   * cached and propagates, so a later persist cannot overwrite tombstones that were merely unreadable.
   */
  async function loadTombs(): Promise<Map<string, { rev: number; at: number }>> {
    if (tombs) return tombs;
    const map = new Map<string, { rev: number; at: number }>();
    const bytes = await io.read(tombFile); // throws on a transient error
    if (bytes !== null) {
      try {
        const raw: unknown = JSON.parse(bytes.toString("utf8"));
        if (!Array.isArray(raw)) throw new Error("not an array");
        for (const e of raw) {
          if (isObject(e) && isValidDocId(e.id) && typeof e.rev === "number" && Number.isSafeInteger(e.rev) && typeof e.at === "number" && Number.isFinite(e.at)) {
            map.set(e.id, { rev: e.rev, at: e.at });
          }
        }
      } catch (err) {
        console.error(`docStore: ignoring ${TOMBSTONE_FILE}: ${message(err)}`);
        map.clear();
      }
    }
    tombs = map;
    return map;
  }

  /** Drops the oldest entries beyond the cap. */
  function cap(map: Map<string, { rev: number; at: number }>): void {
    if (map.size <= MAX_TOMBSTONES) return;
    const oldestFirst = [...map].sort((x, y) => x[1].at - y[1].at);
    for (let i = 0; i < map.size - MAX_TOMBSTONES; i++) map.delete(oldestFirst[i][0]);
  }

  /** Reads the loaded set (do not mutate it). Rejects when the file cannot be read. */
  function readTombs<T>(fn: (map: ReadonlyMap<string, { rev: number; at: number }>) => T): Promise<T> {
    return serialized(TOMB_KEY, async () => fn(await loadTombs()));
  }

  /**
   * Applies `mutate` to a copy, caps it, persists it and only then makes it the in-memory set: a failed
   * persist leaves memory and disk both unchanged. Rejects on a read or write failure.
   */
  function updateTombs(mutate: (map: Map<string, { rev: number; at: number }>) => void): Promise<void> {
    return serialized(TOMB_KEY, async () => {
      const next = new Map(await loadTombs());
      mutate(next);
      cap(next);
      const arr = [...next].map(([id, t]) => ({ id, rev: t.rev, at: t.at }));
      await io.write(tombFile, Buffer.from(JSON.stringify(arr), "utf8"));
      tombs = next;
    });
  }

  /** The stored document at `id`, or null when absent or unusable (a corrupt file is overwritten by the next save). */
  async function readStored(id: string): Promise<StoredDoc | null> {
    const bytes = await io.read(fileOf(id));
    if (bytes === null) return null;
    try {
      const parsed = parseStoredDoc(JSON.parse(bytes.toString("utf8")));
      return "doc" in parsed && parsed.doc.id === id ? parsed.doc : null;
    } catch {
      return null;
    }
  }

  async function list(): Promise<DocListResult> {
    try {
      const files = await io.listFiles(rootDir);
      await sweepStaleTmp(io, rootDir, files, now, "docStore");
      const docs: StoredDoc[] = [];
      for (const { name } of files) {
        const match = FILE_NAME.exec(name);
        if (!match) continue; // temp files and strangers
        const id = match[1];
        try {
          // On the id's chain, so a cache fill cannot interleave with a save or remove.
          const doc = await serialized(id, async (): Promise<StoredDoc | null> => {
            const bytes = await io.read(path.join(rootDir, name));
            if (bytes === null) return null; // removed meanwhile
            const parsed = parseStoredDoc(JSON.parse(bytes.toString("utf8")));
            if ("error" in parsed) {
              console.error(`docStore: skipping ${name}: ${parsed.error}`);
              return null;
            }
            if (parsed.doc.id !== id) {
              console.error(`docStore: skipping ${name}: id mismatch`);
              return null;
            }
            revs.set(id, parsed.doc.rev);
            return parsed.doc;
          });
          if (doc) docs.push(doc);
        } catch (err) {
          console.error(`docStore: skipping ${name}: ${message(err)}`);
        }
      }
      // A transient tombstone read error must not fail the whole list: answer without tombstones (not cached).
      const deleted = await readTombs((map) => [...map].map(([id, t]) => ({ id, rev: t.rev }))).catch((err) => {
        console.error(`docStore: could not read ${TOMBSTONE_FILE}: ${message(err)}`);
        return [] as DocTombstone[];
      });
      return { docs, deleted };
    } catch (err) {
      return { error: `could not list documents: ${message(err)}` };
    }
  }

  async function save(raw: unknown): Promise<DocSaveResult> {
    const parsed = parseStoredDoc(raw);
    if ("error" in parsed) return { error: parsed.error };
    const doc = parsed.doc;
    try {
      return await serialized(doc.id, async (): Promise<DocSaveResult> => {
        const tomb = await readTombs((map) => map.get(doc.id)); // rejects on a transient read error: no write without the check
        if (tomb && doc.rev <= tomb.rev) return { ok: true, stale: true, rev: tomb.rev };
        let storedRev = revs.get(doc.id);
        if (storedRev === undefined) {
          storedRev = (await readStored(doc.id))?.rev;
          if (storedRev !== undefined) revs.set(doc.id, storedRev);
        }
        if (storedRev !== undefined && storedRev >= doc.rev) return { ok: true, stale: true, rev: storedRev };
        await io.write(fileOf(doc.id), Buffer.from(JSON.stringify(doc), "utf8"));
        revs.set(doc.id, doc.rev);
        if (tomb) {
          // A higher rev wins over the deletion (the user made the document again).
          // The doc write already succeeded: if persisting the cleared set fails, memory keeps the tombstone too.
          try {
            await updateTombs((map) => void map.delete(doc.id));
          } catch (err) {
            console.error(`docStore: could not clear tombstone of ${doc.id} (kept): ${message(err)}`);
          }
        }
        return { ok: true, rev: doc.rev };
      });
    } catch (err) {
      return { error: `could not write document: ${message(err)}` };
    }
  }

  async function remove(id: unknown): Promise<DocRemoveResult> {
    if (!isValidDocId(id)) return { error: "invalid document id" };
    try {
      await serialized(id, async () => {
        const storedRev = revs.get(id) ?? (await readStored(id))?.rev;
        revs.delete(id); // also on failure: the next save re-reads the file
        if (storedRev === undefined) {
          await io.remove(fileOf(id)); // nothing usable was stored: no tombstone, but still drop a corrupt file
          return;
        }
        // Tombstone first: a crash between the two leaves a refused-save marker over a live file, never a deleted file nobody remembers.
        const entry = { rev: storedRev, at: now() };
        let prev: { rev: number; at: number } | undefined;
        await updateTombs((map) => {
          prev = map.get(id);
          map.set(id, entry);
        });
        try {
          await io.remove(fileOf(id));
        } catch (err) {
          // The file is still there: take the marker back so the document stays savable.
          await updateTombs((map) => {
            if (prev) map.set(id, prev);
            else map.delete(id);
          }).catch(() => undefined);
          throw err;
        }
      });
      return { ok: true };
    } catch (err) {
      return { error: `could not delete document: ${message(err)}` };
    }
  }

  return { list, save, remove };
}
