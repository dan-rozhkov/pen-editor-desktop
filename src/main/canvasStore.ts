import * as path from "node:path";
import { isValidCanvasId } from "./config";
import { nodeDocFs, type DocFs } from "./docStore";
import { createKeyedChain, isObject, message, sweepStaleTmp } from "./storeUtils";

/**
 * Local storage of the user's canvases (the editor's `.pen` documents), on the same
 * principle as docStore.ts. Two files per canvas in `<root>/`:
 *   `<id>.meta.json` = `{id, title, updatedAt, rev}`      (small; `list` reads only these)
 *   `<id>.pen.json`  = `{id, rev, document}`               (`document` is the serialized `.pen` string)
 * Write order: body first, then meta, so a meta never points at a body that is not there.
 * A meta without a matching body (or a body whose rev is below the meta rev) reads as null.
 *
 * Newer-rev-wins, per-id promise chain, in-memory rev cache and the temp-file sweep behave as in
 * docStore. Canvases are user data and are never pruned. Pure and Electron-free (fs is a port).
 */

export const CANVAS_DIR = "canvases";
/** Directory used while `PEN_DESKTOP_URL` overrides the editor: a dev frontend must never touch production canvases. */
export const DEV_CANVAS_DIR = "canvases-dev";

/** The canvases directory name: `canvases-dev` when the editor URL is overridden, else `canvases`. */
export function canvasDirFor(overrideActive: boolean): string {
  return overrideActive ? DEV_CANVAS_DIR : CANVAS_DIR;
}

export const MAX_CANVAS_TITLE_CHARS = 10_000;
export const MAX_CANVAS_DOCUMENT_BYTES = 64 * 1024 * 1024;

export interface CanvasMeta {
  id: string;
  title: string;
  updatedAt: number;
  rev: number;
}

export interface StoredCanvas extends CanvasMeta {
  /** The serialized `.pen` document (JSON text). */
  document: string;
}

export type CanvasListResult = { canvases: CanvasMeta[] } | { error: string };
export type CanvasReadResult = { canvas: StoredCanvas | null } | { error: string };
export type CanvasSaveResult = { ok: true; rev: number } | { ok: true; stale: true; rev: number } | { error: string };
export type CanvasRemoveResult = { ok: true } | { error: string };

export interface CanvasStore {
  /** Metadata of every valid stored canvas (meta files only). Unreadable files are skipped and logged. Never throws. */
  list(): Promise<CanvasListResult>;
  /** One canvas with its document, or `{canvas:null}` when absent, incomplete or stale. Never throws. */
  read(id: unknown): Promise<CanvasReadResult>;
  /** Validates and stores a canvas (newer rev wins). Never throws. */
  save(canvas: unknown): Promise<CanvasSaveResult>;
  /** Deletes a canvas; a missing one is fine. Never throws. */
  remove(id: unknown): Promise<CanvasRemoveResult>;
}

export interface CanvasStoreOptions {
  /** Absolute path of the canvases directory (`<userData>/canvases`). */
  rootDir: string;
  fs?: DocFs;
  /** Clock for sweeping stale temp files. Default Date.now. */
  now?: () => number;
}

const META_NAME = /^([A-Za-z0-9_-]{1,64})\.meta\.json$/;
const isRev = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

/** The four meta fields of a valid canvas, or an error. Anything else on the input is dropped. */
export function parseCanvasMeta(raw: unknown): { meta: CanvasMeta } | { error: string } {
  if (!isObject(raw)) return { error: "invalid canvas" };
  const { id, title, updatedAt, rev } = raw;
  if (!isValidCanvasId(id)) return { error: "invalid canvas id" };
  if (typeof title !== "string" || title.length > MAX_CANVAS_TITLE_CHARS) return { error: "invalid title" };
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return { error: "invalid updatedAt" };
  if (!isRev(rev)) return { error: "invalid rev" };
  return { meta: { id, title, updatedAt, rev } };
}

/** The five contract fields of a valid canvas, or an error. */
export function parseStoredCanvas(raw: unknown): { canvas: StoredCanvas } | { error: string } {
  const parsed = parseCanvasMeta(raw);
  if ("error" in parsed) return parsed;
  const document = (raw as Record<string, unknown>).document;
  // A string of n UTF-16 units is at most 3n bytes: the cheap bound skips the byte count for small texts.
  if (typeof document !== "string" || (document.length * 3 > MAX_CANVAS_DOCUMENT_BYTES && Buffer.byteLength(document, "utf8") > MAX_CANVAS_DOCUMENT_BYTES)) {
    return { error: "document too large" };
  }
  return { canvas: { ...parsed.meta, document } };
}

export function createCanvasStore(opts: CanvasStoreOptions): CanvasStore {
  const { rootDir } = opts;
  const io = opts.fs ?? nodeDocFs;
  const now = opts.now ?? Date.now;
  // Last known stored (meta) rev per id. This process is the only writer, so it stays true.
  const revs = new Map<string, number>();
  const metaFile = (id: string) => path.join(rootDir, `${id}.meta.json`);
  const bodyFile = (id: string) => path.join(rootDir, `${id}.pen.json`);
  const serialized = createKeyedChain();

  /** The stored meta at `id`, or null when absent or unusable (a corrupt file is overwritten by the next save). */
  async function readMeta(id: string): Promise<CanvasMeta | null> {
    const bytes = await io.read(metaFile(id));
    if (bytes === null) return null;
    try {
      const parsed = parseCanvasMeta(JSON.parse(bytes.toString("utf8")));
      return "meta" in parsed && parsed.meta.id === id ? parsed.meta : null;
    } catch {
      return null;
    }
  }

  async function list(): Promise<CanvasListResult> {
    try {
      const files = await io.listFiles(rootDir);
      await sweepStaleTmp(io, rootDir, files, now, "canvasStore");
      const canvases: CanvasMeta[] = [];
      for (const { name } of files) {
        const match = META_NAME.exec(name);
        if (!match) continue; // bodies, temp files and strangers
        const id = match[1];
        try {
          const meta = await serialized(id, async (): Promise<CanvasMeta | null> => {
            const bytes = await io.read(path.join(rootDir, name));
            if (bytes === null) return null; // removed meanwhile
            const parsed = parseCanvasMeta(JSON.parse(bytes.toString("utf8")));
            if ("error" in parsed) {
              console.error(`canvasStore: skipping ${name}: ${parsed.error}`);
              return null;
            }
            if (parsed.meta.id !== id) {
              console.error(`canvasStore: skipping ${name}: id mismatch`);
              return null;
            }
            revs.set(id, parsed.meta.rev);
            return parsed.meta;
          });
          if (meta) canvases.push(meta);
        } catch (err) {
          console.error(`canvasStore: skipping ${name}: ${message(err)}`);
        }
      }
      return { canvases };
    } catch (err) {
      return { error: `could not list canvases: ${message(err)}` };
    }
  }

  async function read(id: unknown): Promise<CanvasReadResult> {
    if (!isValidCanvasId(id)) return { error: "invalid canvas id" };
    try {
      return await serialized(id, async (): Promise<CanvasReadResult> => {
        const meta = await readMeta(id);
        if (meta === null) return { canvas: null };
        const bytes = await io.read(bodyFile(id));
        if (bytes === null) return { canvas: null };
        let body: unknown;
        try {
          body = JSON.parse(bytes.toString("utf8"));
        } catch {
          return { canvas: null };
        }
        if (!isObject(body) || body.id !== id || !isRev(body.rev) || body.rev < meta.rev || typeof body.document !== "string") {
          return { canvas: null };
        }
        return { canvas: { ...meta, document: body.document } };
      });
    } catch (err) {
      return { error: `could not read canvas: ${message(err)}` };
    }
  }

  async function save(raw: unknown): Promise<CanvasSaveResult> {
    const parsed = parseStoredCanvas(raw);
    if ("error" in parsed) return { error: parsed.error };
    const canvas = parsed.canvas;
    try {
      return await serialized(canvas.id, async (): Promise<CanvasSaveResult> => {
        let storedRev = revs.get(canvas.id);
        if (storedRev === undefined) {
          storedRev = (await readMeta(canvas.id))?.rev;
          if (storedRev !== undefined) revs.set(canvas.id, storedRev);
        }
        if (storedRev !== undefined && storedRev >= canvas.rev) return { ok: true, stale: true, rev: storedRev };
        // Body first: a crash between the two writes leaves the old meta, whose rev the body still satisfies.
        await io.write(bodyFile(canvas.id), Buffer.from(JSON.stringify({ id: canvas.id, rev: canvas.rev, document: canvas.document }), "utf8"));
        const meta: CanvasMeta = { id: canvas.id, title: canvas.title, updatedAt: canvas.updatedAt, rev: canvas.rev };
        await io.write(metaFile(canvas.id), Buffer.from(JSON.stringify(meta), "utf8"));
        revs.set(canvas.id, canvas.rev);
        return { ok: true, rev: canvas.rev };
      });
    } catch (err) {
      return { error: `could not write canvas: ${message(err)}` };
    }
  }

  async function remove(id: unknown): Promise<CanvasRemoveResult> {
    if (!isValidCanvasId(id)) return { error: "invalid canvas id" };
    try {
      await serialized(id, async () => {
        revs.delete(id); // also on failure: the next save re-reads the meta
        await io.remove(metaFile(id)); // meta first: a half-deleted canvas disappears from the list
        await io.remove(bodyFile(id));
      });
      return { ok: true };
    } catch (err) {
      return { error: `could not delete canvas: ${message(err)}` };
    }
  }

  return { list, read, save, remove };
}
