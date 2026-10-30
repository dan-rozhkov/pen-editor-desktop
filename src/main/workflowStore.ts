import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { isValidWorkflowId } from "./config";
import { createKeyedChain, isObject, message, sweepStaleTmp } from "./storeUtils";

export { STALE_TMP_MS } from "./storeUtils";

/**
 * Local storage of the user's workflows (the frontend's `/workflow` surface):
 * `<root>/<id>.json`, one compact JSON file per workflow. The frontend keeps
 * localStorage as the working copy and mirrors every write here.
 *
 * Newer-rev-wins: a save whose `rev` is not above the stored one writes nothing.
 * The read-compare-write of one id runs on a per-id promise chain, so two
 * concurrent saves cannot both pass the check. Workflows are user data and are
 * never pruned. Pure and Electron-free: the file system is a port (same shape as
 * traceStore.ts), so the store is unit-tested under plain Node.
 */

export const WORKFLOW_DIR = "workflows";
/** Directory used while `PEN_DESKTOP_URL` overrides the editor: a dev frontend must never read or overwrite production workflows. */
export const DEV_WORKFLOW_DIR = "workflows-dev";

/** The workflows directory name: `workflows-dev` when the editor URL is overridden, else `workflows`. */
export function workflowDirFor(overrideActive: boolean): string {
  return overrideActive ? DEV_WORKFLOW_DIR : WORKFLOW_DIR;
}
/** Tombstones live in one file next to the workflows. The leading dot keeps it out of `FILE_NAME`, so `list` never reads it as a workflow. */
export const TOMBSTONE_FILE = ".deleted.json";
/**
 * Tombstones are never aged out: they are the only guard for a page copy that never heard about the
 * deletion. The set is capped instead; on write the oldest (`at`) entries beyond the cap are dropped.
 */
export const MAX_TOMBSTONES = 10_000;
export const MAX_WORKFLOW_TITLE_CHARS = 10_000;
export const MAX_STEP_ID_CHARS = 128;
export const MAX_WORKFLOW_BYTES = 5 * 1024 * 1024;

export interface StoredWorkflow {
  id: string;
  title: string;
  steps: { id: string; text: string }[];
  updatedAt: number;
  rev: number;
}

export interface WorkflowFs {
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
export const nodeWorkflowFs: WorkflowFs = {
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

/** A deleted workflow: the rev it had when removed. A save at or below that rev is refused. */
export interface WorkflowTombstone {
  id: string;
  rev: number;
}
export type WorkflowListResult = { workflows: StoredWorkflow[]; deleted: WorkflowTombstone[] } | { error: string };
export type WorkflowSaveResult = { ok: true; rev: number } | { ok: true; stale: true; rev: number } | { error: string };
export type WorkflowRemoveResult = { ok: true } | { error: string };

export interface WorkflowStore {
  /** Every valid stored workflow plus the tombstones of deleted ones. Unreadable or invalid files are skipped and logged. Never throws. */
  list(): Promise<WorkflowListResult>;
  /** Validates and stores a workflow (newer rev wins). Never throws. */
  save(workflow: unknown): Promise<WorkflowSaveResult>;
  /** Deletes a workflow and records a tombstone (only when a workflow was stored); a missing one is fine. Never throws. */
  remove(id: unknown): Promise<WorkflowRemoveResult>;
}

export interface WorkflowStoreOptions {
  /** Absolute path of the workflows directory (`<userData>/workflows`). */
  rootDir: string;
  fs: WorkflowFs;
  /** Clock for sweeping stale temp files. Default Date.now. */
  now?: () => number;
}

/** The workflow id of a file name `<id>.json`, or null (temp files, tombstones, strangers). Agrees with `isValidWorkflowId` by construction. */
function idOfFileName(name: string): string | null {
  if (!name.endsWith(".json")) return null;
  const id = name.slice(0, -".json".length);
  return isValidWorkflowId(id) ? id : null;
}

/** The contract fields of a valid workflow, or an error. Anything else on the input (also inside steps) is dropped. */
export function parseStoredWorkflow(raw: unknown): { workflow: StoredWorkflow } | { error: string } {
  if (!isObject(raw)) return { error: "invalid workflow" };
  const { id, title, steps, updatedAt, rev } = raw;
  if (!isValidWorkflowId(id)) return { error: "invalid workflow id" };
  if (typeof title !== "string" || title.length > MAX_WORKFLOW_TITLE_CHARS) return { error: "invalid title" };
  if (!Array.isArray(steps)) return { error: "invalid steps" };
  const cleanSteps: { id: string; text: string }[] = [];
  for (const step of steps) {
    if (!isObject(step)) return { error: "invalid step" };
    if (typeof step.id !== "string" || step.id.length < 1 || step.id.length > MAX_STEP_ID_CHARS) return { error: "invalid step id" };
    if (typeof step.text !== "string") return { error: "invalid step text" };
    cleanSteps.push({ id: step.id, text: step.text });
  }
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return { error: "invalid updatedAt" };
  if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 1) return { error: "invalid rev" };
  const workflow: StoredWorkflow = { id, title, steps: cleanSteps, updatedAt, rev };
  if (Buffer.byteLength(JSON.stringify(workflow), "utf8") > MAX_WORKFLOW_BYTES) return { error: "workflow too large" };
  return { workflow };
}

export function createWorkflowStore(opts: WorkflowStoreOptions): WorkflowStore {
  const { rootDir, fs: io } = opts;
  const now = opts.now ?? Date.now;
  // Last known stored rev per id. This process is the only writer, so it stays true;
  // absent or corrupt files are never cached.
  const revs = new Map<string, number>();
  const fileOf = (id: string) => path.join(rootDir, `${id}.json`);
  const serialized = createKeyedChain();
  const tombFile = path.join(rootDir, TOMBSTONE_FILE);
  // The tombstone file is one shared read-modify-write, so it has its own chain (the key cannot be a workflow id).
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
          if (isObject(e) && isValidWorkflowId(e.id) && typeof e.rev === "number" && Number.isSafeInteger(e.rev) && typeof e.at === "number" && Number.isFinite(e.at)) {
            map.set(e.id, { rev: e.rev, at: e.at });
          }
        }
      } catch (err) {
        console.error(`workflowStore: ignoring ${TOMBSTONE_FILE}: ${message(err)}`);
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

  /** The stored workflow at `id`, or null when absent or unusable (a corrupt file is overwritten by the next save). */
  async function readStored(id: string): Promise<StoredWorkflow | null> {
    const bytes = await io.read(fileOf(id));
    if (bytes === null) return null;
    try {
      const parsed = parseStoredWorkflow(JSON.parse(bytes.toString("utf8")));
      return "workflow" in parsed && parsed.workflow.id === id ? parsed.workflow : null;
    } catch {
      return null;
    }
  }

  async function list(): Promise<WorkflowListResult> {
    try {
      const files = await io.listFiles(rootDir);
      await sweepStaleTmp(io, rootDir, files, now, "workflowStore");
      const workflows: StoredWorkflow[] = [];
      for (const { name } of files) {
        const id = idOfFileName(name);
        if (id === null) continue; // temp files and strangers
        try {
          // On the id's chain, so a cache fill cannot interleave with a save or remove.
          const wf = await serialized(id, async (): Promise<StoredWorkflow | null> => {
            const bytes = await io.read(path.join(rootDir, name));
            if (bytes === null) return null; // removed meanwhile
            const parsed = parseStoredWorkflow(JSON.parse(bytes.toString("utf8")));
            if ("error" in parsed) {
              console.error(`workflowStore: skipping ${name}: ${parsed.error}`);
              return null;
            }
            if (parsed.workflow.id !== id) {
              console.error(`workflowStore: skipping ${name}: id mismatch`);
              return null;
            }
            revs.set(id, parsed.workflow.rev);
            return parsed.workflow;
          });
          if (wf) workflows.push(wf);
        } catch (err) {
          console.error(`workflowStore: skipping ${name}: ${message(err)}`);
        }
      }
      // A transient tombstone read error must not fail the whole list: answer without tombstones (not cached).
      const deleted = await readTombs((map) => [...map].map(([id, t]) => ({ id, rev: t.rev }))).catch((err) => {
        console.error(`workflowStore: could not read ${TOMBSTONE_FILE}: ${message(err)}`);
        return [] as WorkflowTombstone[];
      });
      return { workflows, deleted };
    } catch (err) {
      return { error: `could not list workflows: ${message(err)}` };
    }
  }

  async function save(raw: unknown): Promise<WorkflowSaveResult> {
    const parsed = parseStoredWorkflow(raw);
    if ("error" in parsed) return { error: parsed.error };
    const wf = parsed.workflow;
    try {
      return await serialized(wf.id, async (): Promise<WorkflowSaveResult> => {
        const tomb = await readTombs((map) => map.get(wf.id)); // rejects on a transient read error: no write without the check
        if (tomb && wf.rev <= tomb.rev) return { ok: true, stale: true, rev: tomb.rev };
        let storedRev = revs.get(wf.id);
        if (storedRev === undefined) {
          storedRev = (await readStored(wf.id))?.rev;
          if (storedRev !== undefined) revs.set(wf.id, storedRev);
        }
        if (storedRev !== undefined && storedRev >= wf.rev) return { ok: true, stale: true, rev: storedRev };
        await io.write(fileOf(wf.id), Buffer.from(JSON.stringify(wf), "utf8"));
        revs.set(wf.id, wf.rev);
        if (tomb) {
          // A higher rev wins over the deletion (the user made the workflow again).
          // The workflow write already succeeded: if persisting the cleared set fails, memory keeps the tombstone too.
          try {
            await updateTombs((map) => void map.delete(wf.id));
          } catch (err) {
            console.error(`workflowStore: could not clear tombstone of ${wf.id} (kept): ${message(err)}`);
          }
        }
        return { ok: true, rev: wf.rev };
      });
    } catch (err) {
      return { error: `could not write workflow: ${message(err)}` };
    }
  }

  async function remove(id: unknown): Promise<WorkflowRemoveResult> {
    if (!isValidWorkflowId(id)) return { error: "invalid workflow id" };
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
          // The file is still there: take the marker back so the workflow stays savable.
          await updateTombs((map) => {
            if (prev) map.set(id, prev);
            else map.delete(id);
          }).catch(() => undefined);
          throw err;
        }
      });
      return { ok: true };
    } catch (err) {
      return { error: `could not delete workflow: ${message(err)}` };
    }
  }

  return { list, save, remove };
}
