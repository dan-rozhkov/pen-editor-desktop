import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import {
  BROWSE_TRACE_ASSET_PATH,
  BROWSE_TRACE_ID,
  parseBrowseTrace,
  type BrowseTrace,
} from "@sideform/browser-agent/agent/session";

/**
 * Local storage of browse-run traces (design: browser-agent
 * docs/specs/2026-10-20-browse-run-trace-design.md, Part 3).
 *
 * Layout: `<root>/<id>/trace.json` plus `<root>/<id>/frames/<n>.<ext>`.
 * `trace.json` is written LAST, so a directory without it is an unfinished save
 * and is never read. Pure and Electron-free: the file system is a port, so the
 * store is unit-tested under plain Node (same shape as credentialStore.ts).
 *
 * Main is the trust boundary: ids and asset paths are checked here with the
 * package's own regexes, so no path can leave the traces directory.
 */

export const TRACE_DIR = "browse-traces";
export const TRACE_FILE = "trace.json";
export const MAX_TRACES = 100;
export const MAX_ASSETS = 160;
export const MAX_ASSET_BYTES = 3 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
/** Cap on the whole payload (manifest + every data URL), checked before any decoding. */
export const MAX_PAYLOAD_BYTES = 48 * 1024 * 1024;
/** Unfinished save directories older than this are swept. */
const STALE_TMP_MS = 60 * 60 * 1000;
const TMP_PREFIX = ".tmp-";

export interface TraceFs {
  /** The file bytes, or null when the file does not exist (ENOENT only; any other failure rejects). */
  read(filePath: string): Promise<Buffer | null>;
  /** Creates parent directories; atomic replace (tmp + rename). Rejects on failure. */
  write(filePath: string, data: Buffer): Promise<void>;
  /** Immediate subdirectories of `dir` with their mtime (ms). A missing `dir` gives []. */
  listDirs(dir: string): Promise<{ name: string; mtimeMs: number }[]>;
  /** True when the directory exists. */
  dirExists(dirPath: string): Promise<boolean>;
  /** Moves a directory. Rejects when the target exists and is not empty. */
  renameDir(from: string, to: string): Promise<void>;
  /** Removes a directory tree; a missing one is not an error. */
  removeDir(dirPath: string): Promise<void>;
}

const isErrno = (err: unknown, code: string): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;

/** Real fs (fs.promises: nothing blocks the main process). */
export const nodeTraceFs: TraceFs = {
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
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, data, { mode: 0o600 });
    await fsp.rename(tmp, filePath);
  },
  async listDirs(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isErrno(err, "ENOENT")) return [];
      throw err;
    }
    const out: { name: string; mtimeMs: number }[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        out.push({ name: e.name, mtimeMs: (await fsp.stat(path.join(dir, e.name))).mtimeMs });
      } catch (err) {
        if (!isErrno(err, "ENOENT")) throw err; // removed meanwhile
      }
    }
    return out;
  },
  async dirExists(dirPath) {
    try {
      return (await fsp.stat(dirPath)).isDirectory();
    } catch (err) {
      if (isErrno(err, "ENOENT")) return false;
      throw err;
    }
  },
  renameDir: (from, to) => fsp.rename(from, to),
  removeDir: (dirPath) => fsp.rm(dirPath, { recursive: true, force: true }),
};

export interface TraceStoreOptions {
  /** Absolute path of the traces directory (`<userData>/browse-traces`). */
  rootDir: string;
  fs: TraceFs;
  /** Newest traces kept. Default MAX_TRACES. */
  maxTraces?: number;
  /** Clock for sweeping stale unfinished saves. Default Date.now. */
  now?: () => number;
}

export type TraceSaveResult = { id: string } | { error: string };
export type TraceReadResult = { trace: BrowseTrace } | { error: string };

export interface TraceStore {
  /** Validates and stores a trace. Never throws. */
  save(payload: unknown): Promise<TraceSaveResult>;
  /** The manifest with every frame `src` turned into a data URL. Never throws. */
  read(id: unknown): Promise<TraceReadResult>;
}

const MIME_BY_EXT: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
// MIME is case-insensitive (the package's splitTraceAssets matches with /i); it is lowercased before use.
const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]*={0,2})$/i;
/** Longest header a valid asset data URL can have ("data:image/jpeg;base64,"), with slack. */
const DATA_URL_HEADER_MAX = 40;
/** Longest valid data URL for an asset of MAX_ASSET_BYTES. */
const MAX_DATA_URL_CHARS = Math.ceil((MAX_ASSET_BYTES * 4) / 3) + 4 + DATA_URL_HEADER_MAX;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const extOf = (assetPath: string): string => assetPath.slice(assetPath.lastIndexOf(".") + 1);
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Decoded size of a base64 payload without decoding it. */
function base64Bytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

export function createTraceStore(opts: TraceStoreOptions): TraceStore {
  const { rootDir, fs: io } = opts;
  const maxTraces = opts.maxTraces ?? MAX_TRACES;
  const now = opts.now ?? Date.now;
  const dirOf = (id: string) => path.join(rootDir, id);

  /** Drops the oldest trace directories past the cap, and stale unfinished saves. `keepId` is never removed. */
  async function prune(keepId: string): Promise<void> {
    try {
      const all = await io.listDirs(rootDir);
      for (const d of all) {
        if (d.name.startsWith(TMP_PREFIX) && now() - d.mtimeMs > STALE_TMP_MS) await io.removeDir(dirOf(d.name));
      }
      const dirs = all.filter((d) => BROWSE_TRACE_ID.test(d.name)).sort((a, b) => b.mtimeMs - a.mtimeMs);
      let kept = 0;
      for (const d of dirs) {
        if (d.name === keepId || kept < maxTraces) {
          kept++;
          continue;
        }
        await io.removeDir(dirOf(d.name));
      }
    } catch (err) {
      console.error("traceStore: prune failed", err);
    }
  }

  async function save(payload: unknown): Promise<TraceSaveResult> {
    if (!isObject(payload)) return { error: "invalid payload" };
    const rawAssets = payload.assets;
    if (!Array.isArray(rawAssets)) return { error: "assets: expected an array" };
    if (rawAssets.length > MAX_ASSETS) return { error: "too many assets" };

    // Cheap size checks first: nothing is parsed, matched or decoded before them.
    let total = 0;
    for (const raw of rawAssets) {
      if (!isObject(raw) || typeof raw.path !== "string" || typeof raw.dataUrl !== "string") {
        return { error: "assets: invalid entry" };
      }
      if (raw.dataUrl.length > MAX_DATA_URL_CHARS) return { error: `assets: ${JSON.stringify(raw.path)} is too large` };
      total += raw.dataUrl.length;
    }
    if (total > MAX_PAYLOAD_BYTES) return { error: "payload too large" };

    const parsed = parseBrowseTrace(payload.manifest);
    if ("error" in parsed) return { error: `invalid trace: ${parsed.error}` };
    const trace = parsed.trace;
    // parseBrowseTrace already checked the id; the regex is repeated here because it is the path guard.
    if (!BROWSE_TRACE_ID.test(trace.id)) return { error: "invalid trace id" };

    const manifestText = JSON.stringify(trace);
    const manifestBytes = Buffer.byteLength(manifestText, "utf8");
    if (manifestBytes > MAX_MANIFEST_BYTES) return { error: "manifest too large" };
    if (total + manifestBytes > MAX_PAYLOAD_BYTES) return { error: "payload too large" };

    const files = new Map<string, Buffer>();
    for (const raw of rawAssets as { path: string; dataUrl: string }[]) {
      // Extensions are lowercase by construction: the path regex is case-sensitive.
      if (!BROWSE_TRACE_ASSET_PATH.test(raw.path)) return { error: `assets: invalid path ${JSON.stringify(raw.path)}` };
      if (files.has(raw.path)) return { error: `assets: duplicate path ${raw.path}` };
      const match = DATA_URL.exec(raw.dataUrl);
      if (!match) return { error: `assets: ${raw.path} is not an image data URL` };
      if (MIME_BY_EXT[extOf(raw.path)] !== match[1]!.toLowerCase()) return { error: `assets: ${raw.path} does not match its type` };
      if (base64Bytes(match[2]!) > MAX_ASSET_BYTES) return { error: `assets: ${raw.path} is too large` };
      files.set(raw.path, Buffer.from(match[2]!, "base64"));
    }

    // Every frame points at a stored asset, and every asset is used by a frame.
    const referenced = new Set<string>();
    for (const frame of trace.frames) {
      if (!files.has(frame.src)) return { error: `frame ${frame.id}: no asset for src` };
      referenced.add(frame.src);
    }
    for (const assetPath of files.keys()) {
      if (!referenced.has(assetPath)) return { error: `assets: ${assetPath} is not referenced by a frame` };
    }

    const dir = dirOf(trace.id);
    // Write-once: an existing trace is never replaced.
    try {
      if (await io.dirExists(dir)) return { error: "trace exists" };
    } catch (err) {
      return { error: `could not write trace: ${message(err)}` };
    }
    // Build in a sibling temp dir and move it into place at the end: a reader never sees a half-written trace.
    const tmp = path.join(rootDir, `${TMP_PREFIX}${trace.id}-${randomBytes(6).toString("hex")}`);
    try {
      for (const [assetPath, data] of files) await io.write(path.join(tmp, assetPath), data);
      await io.write(path.join(tmp, TRACE_FILE), Buffer.from(manifestText, "utf8"));
      await io.renameDir(tmp, dir); // fails when a concurrent save won the id
    } catch (err) {
      try {
        await io.removeDir(tmp); // only our own temp dir
      } catch {
        /* best effort */
      }
      return { error: `could not write trace: ${message(err)}` };
    }
    await prune(trace.id);
    return { id: trace.id };
  }

  async function read(id: unknown): Promise<TraceReadResult> {
    if (typeof id !== "string" || !BROWSE_TRACE_ID.test(id)) return { error: "invalid trace id" };
    try {
      const dir = dirOf(id);
      const text = await io.read(path.join(dir, TRACE_FILE));
      if (text === null) return { error: "trace not found" };
      let json: unknown;
      try {
        json = JSON.parse(text.toString("utf8"));
      } catch {
        return { error: "trace file is not valid JSON" };
      }
      const parsed = parseBrowseTrace(json);
      if ("error" in parsed) return { error: `invalid trace: ${parsed.error}` };
      if (parsed.trace.id !== id) return { error: "invalid trace: id mismatch" };
      const frames = [];
      for (const frame of parsed.trace.frames) {
        if (!BROWSE_TRACE_ASSET_PATH.test(frame.src)) return { error: `frame ${frame.id}: invalid src` };
        const bytes = await io.read(path.join(dir, frame.src));
        if (bytes === null) return { error: `frame ${frame.id}: file is missing` };
        frames.push({ ...frame, src: `data:${MIME_BY_EXT[extOf(frame.src)]};base64,${bytes.toString("base64")}` });
      }
      return { trace: { ...parsed.trace, frames } };
    } catch (err) {
      return { error: `could not read trace: ${message(err)}` };
    }
  }

  return { save, read };
}
