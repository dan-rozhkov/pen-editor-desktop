import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { isValidDocId } from "./config";

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

export type DocListResult = { docs: StoredDoc[] } | { error: string };
export type DocSaveResult = { ok: true; rev: number } | { ok: true; stale: true; rev: number } | { error: string };
export type DocRemoveResult = { ok: true } | { error: string };

export interface DocStore {
  /** Every valid stored document. Unreadable or invalid files are skipped and logged. Never throws. */
  list(): Promise<DocListResult>;
  /** Validates and stores a document (newer rev wins). Never throws. */
  save(doc: unknown): Promise<DocSaveResult>;
  /** Deletes a document; a missing one is fine. Never throws. */
  remove(id: unknown): Promise<DocRemoveResult>;
}

export interface DocStoreOptions {
  /** Absolute path of the documents directory (`<userData>/documents`). */
  rootDir: string;
  fs: DocFs;
  /** Clock for sweeping stale temp files. Default Date.now. */
  now?: () => number;
}

/** Temp files (`<id>.json.<pid>.<random>.tmp`) older than this are swept by `list`. */
export const STALE_TMP_MS = 60 * 60 * 1000;

const FILE_NAME = /^([A-Za-z0-9_-]{1,64})\.json$/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
  // Tail of the pending work per id; the entry is dropped once the chain is idle.
  const chains = new Map<string, Promise<unknown>>();

  function serialized<T>(id: string, task: () => Promise<T>): Promise<T> {
    const prev = chains.get(id) ?? Promise.resolve();
    const run = prev.then(task, task);
    const tail = run.catch(() => undefined);
    chains.set(id, tail);
    void tail.then(() => {
      if (chains.get(id) === tail) chains.delete(id);
    });
    return run;
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

  /** Best effort: removes temp files left by an interrupted write. */
  async function sweepStaleTmp(files: { name: string; mtimeMs: number }[]): Promise<void> {
    for (const f of files) {
      if (!f.name.endsWith(".tmp") || now() - f.mtimeMs <= STALE_TMP_MS) continue;
      try {
        await io.remove(path.join(rootDir, f.name));
      } catch (err) {
        console.error(`docStore: could not sweep ${f.name}: ${message(err)}`);
      }
    }
  }

  async function list(): Promise<DocListResult> {
    try {
      const files = await io.listFiles(rootDir);
      await sweepStaleTmp(files);
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
      return { docs };
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
        let storedRev = revs.get(doc.id);
        if (storedRev === undefined) {
          storedRev = (await readStored(doc.id))?.rev;
          if (storedRev !== undefined) revs.set(doc.id, storedRev);
        }
        if (storedRev !== undefined && storedRev >= doc.rev) return { ok: true, stale: true, rev: storedRev };
        await io.write(fileOf(doc.id), Buffer.from(JSON.stringify(doc), "utf8"));
        revs.set(doc.id, doc.rev);
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
        revs.delete(id); // also on failure: the next save re-reads the file
        await io.remove(fileOf(id));
      });
      return { ok: true };
    } catch (err) {
      return { error: `could not delete document: ${message(err)}` };
    }
  }

  return { list, save, remove };
}
