import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { canvasDirFor, createCanvasStore, MAX_CANVAS_TITLE_CHARS } from "../src/main/canvasStore";
import type { DocFs } from "../src/main/docStore";

const ROOT = "/ud/canvases";
const canvas = (over: Record<string, unknown> = {}) => ({ id: "c1", title: "T", document: '{"version":"1"}', updatedAt: 10, rev: 1, ...over });

function memFs() {
  const files = new Map<string, Buffer>();
  const mtimes = new Map<string, number>();
  const order: string[] = [];
  const api: DocFs & { files: Map<string, Buffer>; mtimes: Map<string, number>; order: string[]; delay: number; fail?: RegExp; writes: number; reads: string[] } = {
    files,
    mtimes,
    order,
    delay: 0,
    writes: 0,
    reads: [],
    read: async (p) => {
      api.reads.push(path.basename(p));
      if (api.delay) await new Promise((r) => setTimeout(r, api.delay));
      return files.get(p) ?? null;
    },
    async write(p, data) {
      if (api.fail?.test(p)) throw new Error("disk full");
      api.writes++;
      order.push(path.basename(p));
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
  return { fs, clock, store: createCanvasStore({ rootDir: ROOT, fs, now: () => clock.t }) };
};
const meta = (id: string) => path.join(ROOT, `${id}.meta.json`);
const body = (id: string) => path.join(ROOT, `${id}.pen.json`);

describe("canvasStore", () => {
  it("names the dev dir while the editor URL is overridden", () => {
    expect(canvasDirFor(false)).toBe("canvases");
    expect(canvasDirFor(true)).toBe("canvases-dev");
  });

  it("lists nothing for a missing dir", async () => {
    expect(await setup().store.list()).toEqual({ canvases: [] });
  });

  it("saves body first, then meta, and strips unknown fields", async () => {
    const { store, fs } = setup();
    expect(await store.save({ ...canvas(), extra: "x" })).toEqual({ ok: true, rev: 1 });
    expect(fs.order).toEqual(["c1.pen.json", "c1.meta.json"]);
    expect(JSON.parse(fs.files.get(meta("c1"))!.toString())).toEqual({ id: "c1", title: "T", updatedAt: 10, rev: 1 });
    expect(JSON.parse(fs.files.get(body("c1"))!.toString())).toEqual({ id: "c1", rev: 1, document: canvas().document });
  });

  it("list reads only meta files", async () => {
    const { store, fs } = setup();
    await store.save(canvas());
    await store.save(canvas({ id: "c2", title: "Two" }));
    fs.reads.length = 0;
    const result = await store.list();
    expect(result).toEqual({
      canvases: [
        { id: "c1", title: "T", updatedAt: 10, rev: 1 },
        { id: "c2", title: "Two", updatedAt: 10, rev: 1 },
      ],
    });
    expect(fs.reads.every((n) => n.endsWith(".meta.json"))).toBe(true);
  });

  it("read returns meta plus document", async () => {
    const { store } = setup();
    await store.save(canvas());
    expect(await store.read("c1")).toEqual({ canvas: canvas() });
    expect(await store.read("nope")).toEqual({ canvas: null });
    expect(await store.read("../x")).toEqual({ error: "invalid canvas id" });
  });

  it("read gives null for a missing body or a body below the meta rev", async () => {
    const { store, fs } = setup();
    await store.save(canvas({ rev: 3 }));
    fs.files.set(body("c1"), Buffer.from(JSON.stringify({ id: "c1", rev: 2, document: "old" })));
    expect(await store.read("c1")).toEqual({ canvas: null });
    fs.files.delete(body("c1"));
    expect(await store.read("c1")).toEqual({ canvas: null });
  });

  it("read gives null for a corrupt body", async () => {
    const { store, fs } = setup();
    await store.save(canvas());
    fs.files.set(body("c1"), Buffer.from("{nope"));
    expect(await store.read("c1")).toEqual({ canvas: null });
  });

  it("newer rev wins; an equal or lower rev is stale and writes nothing", async () => {
    const { store, fs } = setup();
    await store.save(canvas({ rev: 2, document: "two" }));
    const writes = fs.writes;
    expect(await store.save(canvas({ rev: 2, document: "other" }))).toEqual({ ok: true, stale: true, rev: 2 });
    expect(await store.save(canvas({ rev: 1 }))).toEqual({ ok: true, stale: true, rev: 2 });
    expect(fs.writes).toBe(writes);
    expect(await store.save(canvas({ rev: 3, document: "three" }))).toEqual({ ok: true, rev: 3 });
    expect(await store.read("c1")).toEqual({ canvas: canvas({ rev: 3, document: "three" }) });
  });

  it("a new store instance reads the stored rev from the meta file", async () => {
    const { store, fs } = setup();
    await store.save(canvas({ rev: 4 }));
    const again = createCanvasStore({ rootDir: ROOT, fs });
    expect(await again.save(canvas({ rev: 4 }))).toEqual({ ok: true, stale: true, rev: 4 });
  });

  it("rejects invalid input", async () => {
    const { store, fs } = setup();
    const bad: [unknown, string][] = [
      [null, "invalid canvas"],
      [[], "invalid canvas"],
      [canvas({ id: "a/b" }), "invalid canvas id"],
      [canvas({ id: "" }), "invalid canvas id"],
      [canvas({ title: 5 }), "invalid title"],
      [canvas({ title: "x".repeat(MAX_CANVAS_TITLE_CHARS + 1) }), "invalid title"],
      [canvas({ document: 5 }), "document too large"],
      [canvas({ updatedAt: NaN }), "invalid updatedAt"],
      [canvas({ updatedAt: "1" }), "invalid updatedAt"],
      [canvas({ rev: 0 }), "invalid rev"],
      [canvas({ rev: 1.5 }), "invalid rev"],
      [canvas({ rev: Number.MAX_SAFE_INTEGER + 1 }), "invalid rev"],
    ];
    for (const [input, error] of bad) expect(await store.save(input)).toEqual({ error });
    expect(fs.writes).toBe(0);
  });

  it("accepts a 64 MB document and refuses one byte more (multi-byte counted in UTF-8)", async () => {
    const { store } = setup();
    const max = 64 * 1024 * 1024;
    expect(await store.save(canvas({ document: "a".repeat(max) }))).toEqual({ ok: true, rev: 1 });
    expect(await store.save(canvas({ rev: 2, document: "a".repeat(max + 1) }))).toEqual({ error: "document too large" });
    expect(await store.save(canvas({ rev: 2, document: "é".repeat(max / 2 + 1) }))).toEqual({ error: "document too large" });
  });

  it("serializes concurrent saves of one id", async () => {
    const { store, fs } = setup();
    fs.delay = 5;
    const results = await Promise.all([store.save(canvas({ rev: 1 })), store.save(canvas({ rev: 1 })), store.save(canvas({ rev: 2 })), store.save(canvas({ rev: 2 }))]);
    expect(results).toEqual([{ ok: true, rev: 1 }, { ok: true, stale: true, rev: 1 }, { ok: true, rev: 2 }, { ok: true, stale: true, rev: 2 }]);
    expect(fs.writes).toBe(4);
  });

  it("remove deletes both files, tolerates a missing canvas, and runs after a pending save", async () => {
    const { store, fs } = setup();
    fs.delay = 5;
    const saving = store.save(canvas());
    const removing = store.remove("c1");
    await saving;
    expect(await removing).toEqual({ ok: true });
    expect(fs.files.has(meta("c1"))).toBe(false);
    expect(fs.files.has(body("c1"))).toBe(false);
    expect(await store.remove("nope")).toEqual({ ok: true });
    expect(await store.remove("../x")).toEqual({ error: "invalid canvas id" });
    // After a remove the id can be saved again from rev 1.
    expect(await store.save(canvas())).toEqual({ ok: true, rev: 1 });
  });

  it("list skips invalid, id-mismatched and unparsable metas", async () => {
    const { store, fs } = setup();
    await store.save(canvas());
    fs.files.set(meta("bad"), Buffer.from("{nope"));
    fs.files.set(meta("mis"), Buffer.from(JSON.stringify({ id: "other", title: "", updatedAt: 1, rev: 1 })));
    fs.files.set(meta("neg"), Buffer.from(JSON.stringify({ id: "neg", title: "", updatedAt: 1, rev: 0 })));
    fs.files.set(path.join(ROOT, "stranger.txt"), Buffer.from("x"));
    expect(await store.list()).toEqual({ canvases: [{ id: "c1", title: "T", updatedAt: 10, rev: 1 }] });
  });

  it("sweeps temp files older than an hour and keeps fresh ones", async () => {
    const { store, fs, clock } = setup();
    const old = path.join(ROOT, "c1.meta.json.1.ab.tmp");
    const fresh = path.join(ROOT, "c2.pen.json.1.cd.tmp");
    fs.files.set(old, Buffer.from("x"));
    fs.files.set(fresh, Buffer.from("x"));
    fs.mtimes.set(old, clock.t - 2 * 3_600_000);
    fs.mtimes.set(fresh, clock.t - 1000);
    await store.list();
    expect(fs.files.has(old)).toBe(false);
    expect(fs.files.has(fresh)).toBe(true);
  });

  it("a failing write returns an error value and does not advance the rev", async () => {
    const { store, fs } = setup();
    fs.fail = /meta\.json/;
    expect(await store.save(canvas())).toEqual({ error: "could not write canvas: disk full" });
    fs.fail = undefined;
    expect(await store.save(canvas())).toEqual({ ok: true, rev: 1 });
  });

  it("never throws when listing fails", async () => {
    const fs = memFs();
    fs.listFiles = async () => {
      throw new Error("EIO");
    };
    expect(await createCanvasStore({ rootDir: ROOT, fs }).list()).toEqual({ error: "could not list canvases: EIO" });
  });
});
