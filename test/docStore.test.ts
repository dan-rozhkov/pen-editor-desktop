import { describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { createDocStore, docDirFor, MAX_DOC_MARKDOWN_BYTES, type DocFs } from "../src/main/docStore";

const ROOT = "/ud/documents";
const doc = (over: Record<string, unknown> = {}) => ({ id: "d1", title: "T", markdown: "# hi", updatedAt: 10, rev: 1, ...over });

function memFs() {
  const files = new Map<string, Buffer>();
  const mtimes = new Map<string, number>();
  const api: DocFs & { files: Map<string, Buffer>; mtimes: Map<string, number>; delay: number; fail?: RegExp; writes: number; reads: number } = {
    files,
    mtimes,
    delay: 0,
    writes: 0,
    reads: 0,
    read: async (p) => {
      api.reads++;
      if (api.delay) await new Promise((r) => setTimeout(r, api.delay));
      return files.get(p) ?? null;
    },
    async write(p, data) {
      if (api.fail?.test(p)) throw new Error("disk full");
      api.writes++;
      files.set(p, data);
    },
    listFiles: async (dir) =>
      [...files.keys()].filter((p) => path.dirname(p) === dir).map((p) => ({ name: path.basename(p), mtimeMs: mtimes.get(p) ?? 0 })),
    remove: async (p) => void files.delete(p),
  };
  return api;
}
const setup = () => {
  const fs = memFs();
  const clock = { t: 10 * 3_600_000 };
  return { fs, clock, store: createDocStore({ rootDir: ROOT, fs, now: () => clock.t }) };
};
const at = (id: string) => path.join(ROOT, `${id}.json`);

describe("docStore", () => {
  it("lists nothing for a missing dir", async () => {
    expect(await setup().store.list()).toEqual({ docs: [] });
  });

  it("saves, lists and strips unknown fields", async () => {
    const { store, fs } = setup();
    expect(await store.save({ ...doc(), extra: "x" })).toEqual({ ok: true, rev: 1 });
    expect(JSON.parse(fs.files.get(at("d1"))!.toString())).toEqual(doc());
    expect(await store.list()).toEqual({ docs: [doc()] });
  });

  it("newer rev wins; an equal or lower rev is stale and writes nothing", async () => {
    const { store, fs } = setup();
    await store.save(doc({ rev: 2, markdown: "two" }));
    expect(await store.save(doc({ rev: 2, markdown: "other" }))).toEqual({ ok: true, stale: true, rev: 2 });
    expect(await store.save(doc({ rev: 1 }))).toEqual({ ok: true, stale: true, rev: 2 });
    expect(fs.writes).toBe(1);
    expect(await store.save(doc({ rev: 3, markdown: "three" }))).toEqual({ ok: true, rev: 3 });
    expect(await store.list()).toEqual({ docs: [doc({ rev: 3, markdown: "three" })] });
  });

  it("serializes concurrent saves of one id", async () => {
    const { store, fs } = setup();
    fs.delay = 5;
    const results = await Promise.all([store.save(doc({ rev: 1 })), store.save(doc({ rev: 1 })), store.save(doc({ rev: 2 })), store.save(doc({ rev: 2 }))]);
    expect(results).toEqual([{ ok: true, rev: 1 }, { ok: true, stale: true, rev: 1 }, { ok: true, rev: 2 }, { ok: true, stale: true, rev: 2 }]);
    expect(fs.writes).toBe(2);
  });

  it("remove deletes, tolerates a missing file, and serializes after a pending save", async () => {
    const { store, fs } = setup();
    fs.delay = 5;
    const saving = store.save(doc());
    const removing = store.remove("d1");
    await saving;
    expect(await removing).toEqual({ ok: true });
    expect(fs.files.has(at("d1"))).toBe(false);
    expect(await store.remove("nope")).toEqual({ ok: true });
  });

  it("rejects invalid input", async () => {
    const { store } = setup();
    const bad: unknown[] = [
      null,
      [],
      "x",
      doc({ id: "../x" }),
      doc({ id: "" }),
      doc({ id: 5 }),
      doc({ title: 1 }),
      doc({ title: "a".repeat(10_001) }),
      doc({ markdown: 1 }),
      doc({ updatedAt: Infinity }),
      doc({ updatedAt: "1" }),
      doc({ rev: 0 }),
      doc({ rev: 1.5 }),
      doc({ rev: Number.MAX_SAFE_INTEGER + 1 }),
    ];
    for (const b of bad) expect(await store.save(b)).toHaveProperty("error");
    expect(await store.remove("../x")).toHaveProperty("error");
    expect(await store.remove(3)).toHaveProperty("error");
  });

  it("enforces the size caps in bytes", async () => {
    const { store } = setup();
    expect(await store.save(doc({ title: "a".repeat(10_000) }))).toEqual({ ok: true, rev: 1 });
    expect(await store.save(doc({ id: "big", markdown: "a".repeat(MAX_DOC_MARKDOWN_BYTES) }))).toEqual({ ok: true, rev: 1 });
    expect(await store.save(doc({ id: "big2", markdown: "a".repeat(MAX_DOC_MARKDOWN_BYTES + 1) }))).toHaveProperty("error");
    // 3-byte chars: fewer characters, more than 5 MB
    expect(await store.save(doc({ id: "big3", markdown: "€".repeat(Math.floor(MAX_DOC_MARKDOWN_BYTES / 3) + 1) }))).toHaveProperty("error");
  });

  it("skips corrupt, invalid, mismatched and temp files when listing", async () => {
    const { store, fs } = setup();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await store.save(doc());
    fs.files.set(at("bad"), Buffer.from("{nope"));
    fs.files.set(at("inv"), Buffer.from(JSON.stringify({ id: "inv" })));
    fs.files.set(at("other"), Buffer.from(JSON.stringify(doc({ id: "d2" }))));
    fs.files.set(`${at("d1")}.123.tmp`, Buffer.from(JSON.stringify(doc({ id: "d1", rev: 9 }))));
    expect(await store.list()).toEqual({ docs: [doc()] });
    expect(err).toHaveBeenCalledTimes(3);
    err.mockRestore();
  });

  it("a second save of the same id does not read the file", async () => {
    const { store, fs } = setup();
    await store.save(doc({ rev: 1 }));
    expect(fs.reads).toBe(1);
    await store.save(doc({ rev: 2 }));
    await store.save(doc({ rev: 2 }));
    expect(fs.reads).toBe(1);
  });

  it("detects stale saves from the cache", async () => {
    const { store, fs } = setup();
    await store.save(doc({ rev: 3 }));
    fs.reads = 0;
    expect(await store.save(doc({ rev: 2 }))).toEqual({ ok: true, stale: true, rev: 3 });
    expect(fs.reads).toBe(0);
  });

  it("a first save reads an existing file once; list fills the cache", async () => {
    const a = setup();
    a.fs.files.set(at("d1"), Buffer.from(JSON.stringify(doc({ rev: 5 }))));
    expect(await a.store.save(doc({ rev: 4 }))).toEqual({ ok: true, stale: true, rev: 5 });
    expect(await a.store.save(doc({ rev: 4 }))).toEqual({ ok: true, stale: true, rev: 5 });
    expect(a.fs.reads).toBe(1);
    const b = setup();
    b.fs.files.set(at("d1"), Buffer.from(JSON.stringify(doc({ rev: 5 }))));
    await b.store.list();
    b.fs.reads = 0;
    expect(await b.store.save(doc({ rev: 5 }))).toEqual({ ok: true, stale: true, rev: 5 });
    expect(b.fs.reads).toBe(0);
  });

  it("remove clears the cached rev", async () => {
    const { store, fs } = setup();
    await store.save(doc({ rev: 7 }));
    await store.remove("d1");
    fs.reads = 0;
    expect(await store.save(doc({ rev: 1 }))).toEqual({ ok: true, rev: 1 });
    expect(fs.reads).toBe(1);
  });

  it("list sweeps temp files older than an hour and keeps fresh ones", async () => {
    const { store, fs, clock } = setup();
    const old = `${at("d1")}.1.tmp`;
    const fresh = `${at("d2")}.2.tmp`;
    fs.files.set(old, Buffer.from("x"));
    fs.mtimes.set(old, clock.t - 3_600_000 - 1);
    fs.files.set(fresh, Buffer.from("x"));
    fs.mtimes.set(fresh, clock.t - 1000);
    expect(await store.list()).toEqual({ docs: [] });
    expect(fs.files.has(old)).toBe(false);
    expect(fs.files.has(fresh)).toBe(true);
  });

  it("a failing sweep is logged and does not fail list", async () => {
    const { store, fs } = setup();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const old = `${at("d1")}.1.tmp`;
    fs.files.set(old, Buffer.from("x"));
    fs.remove = async () => {
      throw new Error("EPERM");
    };
    await store.save(doc({ id: "d3" }));
    expect(await store.list()).toEqual({ docs: [doc({ id: "d3" })] });
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("a corrupt stored file is replaced by the next save", async () => {
    const { store, fs } = setup();
    fs.files.set(at("d1"), Buffer.from("garbage"));
    expect(await store.save(doc())).toEqual({ ok: true, rev: 1 });
  });

  it("reports I/O failures as values", async () => {
    const { store, fs } = setup();
    fs.fail = /d1/;
    expect(await store.save(doc())).toHaveProperty("error");
    fs.listFiles = async () => {
      throw new Error("EIO");
    };
    expect(await store.list()).toHaveProperty("error");
    fs.remove = async () => {
      throw new Error("EPERM");
    };
    expect(await store.remove("d1")).toHaveProperty("error");
    // the chain survives a failure
    fs.fail = undefined;
    expect(await store.save(doc())).toEqual({ ok: true, rev: 1 });
  });
});

describe("docDirFor", () => {
  it("uses documents normally and documents-dev under a PEN_DESKTOP_URL override", () => {
    expect(docDirFor(false)).toBe("documents");
    expect(docDirFor(true)).toBe("documents-dev");
  });
});
