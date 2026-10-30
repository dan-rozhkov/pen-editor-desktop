import { describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { createWorkflowStore, workflowDirFor, MAX_WORKFLOW_BYTES, MAX_TOMBSTONES, type WorkflowFs } from "../src/main/workflowStore";

const ROOT = "/ud/workflows";
const doc = (over: Record<string, unknown> = {}) => ({ id: "wf_d1", title: "T", steps: [{ id: "s1", text: "hi" }], updatedAt: 10, rev: 1, ...over });

function memFs() {
  const files = new Map<string, Buffer>();
  const mtimes = new Map<string, number>();
  const api: WorkflowFs & { files: Map<string, Buffer>; mtimes: Map<string, number>; delay: number; fail?: RegExp; readFail?: { re: RegExp; code: string }; writes: number; reads: number } = {
    files,
    mtimes,
    delay: 0,
    writes: 0,
    reads: 0,
    read: async (p) => {
      if (!p.endsWith(".deleted.json")) api.reads++; // document reads only
      if (api.readFail?.re.test(p)) throw Object.assign(new Error("read failed"), { code: api.readFail.code });
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
  return { fs, clock, store: createWorkflowStore({ rootDir: ROOT, fs, now: () => clock.t }) };
};
const at = (id: string) => path.join(ROOT, `${id}.json`);

describe("workflowStore", () => {
  it("lists nothing for a missing dir", async () => {
    expect(await setup().store.list()).toEqual({ workflows: [], deleted: [] });
  });

  it("saves, lists and strips unknown fields", async () => {
    const { store, fs } = setup();
    expect(await store.save({ ...doc(), extra: "x" })).toEqual({ ok: true, rev: 1 });
    expect(JSON.parse(fs.files.get(at("wf_d1"))!.toString())).toEqual(doc());
    expect(await store.list()).toEqual({ workflows: [doc()], deleted: [] });
  });

  it("has no step-count cap (the byte cap is the bound)", async () => {
    const { store } = setup();
    const steps = Array.from({ length: 5000 }, (_, i) => ({ id: String(i), text: "x" }));
    expect(await store.save(doc({ steps }))).toEqual({ ok: true, rev: 1 });
    const listed = await store.list();
    expect("workflows" in listed && listed.workflows[0].steps).toHaveLength(5000);
  });

  it("a 67-char id (wf_ + 64) saves and lists", async () => {
    const { store } = setup();
    const id = "wf_" + "a".repeat(64);
    expect(await store.save(doc({ id }))).toEqual({ ok: true, rev: 1 });
    expect(await store.list()).toEqual({ workflows: [doc({ id })], deleted: [] });
  });

  it("newer rev wins; an equal or lower rev is stale and writes nothing", async () => {
    const { store, fs } = setup();
    await store.save(doc({ rev: 2, title: "two" }));
    expect(await store.save(doc({ rev: 2, markdown: "wf_other" }))).toEqual({ ok: true, stale: true, rev: 2 });
    expect(await store.save(doc({ rev: 1 }))).toEqual({ ok: true, stale: true, rev: 2 });
    expect(fs.writes).toBe(1);
    expect(await store.save(doc({ rev: 3, title: "three" }))).toEqual({ ok: true, rev: 3 });
    expect(await store.list()).toEqual({ workflows: [doc({ rev: 3, title: "three" })], deleted: [] });
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
    const removing = store.remove("wf_d1");
    await saving;
    expect(await removing).toEqual({ ok: true });
    expect(fs.files.has(at("wf_d1"))).toBe(false);
    expect(await store.remove("wf_nope")).toEqual({ ok: true });
  });

  it("rejects invalid input", async () => {
    const { store } = setup();
    const bad: unknown[] = [
      null,
      [],
      "x",
      doc({ id: "../x" }),
      doc({ id: "d1" }),
      doc({ id: "" }),
      doc({ id: 5 }),
      doc({ title: 1 }),
      doc({ title: "a".repeat(10_001) }),
      doc({ steps: "x" }),
      doc({ steps: [null] }),
      doc({ steps: [{ id: "", text: "a" }] }),
      doc({ steps: [{ id: "a".repeat(129), text: "a" }] }),
      doc({ steps: [{ id: "a", text: 1 }] }),
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
    const bigText = (n: number, ch = "a") => [{ id: "s", text: ch.repeat(n) }];
    const overhead = Buffer.byteLength(JSON.stringify(doc({ id: "wf_big", steps: bigText(0) })), "utf8");
    expect(await store.save(doc({ id: "wf_big", steps: bigText(MAX_WORKFLOW_BYTES - overhead) }))).toEqual({ ok: true, rev: 1 });
    expect(await store.save(doc({ id: "wf_big2", steps: bigText(MAX_WORKFLOW_BYTES - overhead + 1) }))).toHaveProperty("error");
    // 3-byte chars: fewer characters, more than 5 MB
    expect(await store.save(doc({ id: "wf_big3", steps: bigText(Math.floor(MAX_WORKFLOW_BYTES / 3) + 1, "\u20ac") }))).toHaveProperty("error");
  });

  it("drops unknown fields inside steps and accepts an empty step list", async () => {
    const { store } = setup();
    expect(await store.save(doc({ id: "wf_e", steps: [] }))).toEqual({ ok: true, rev: 1 });
    expect(await store.save(doc({ id: "wf_x", steps: [{ id: "a", text: "t", extra: 1 }] }))).toEqual({ ok: true, rev: 1 });
    const r = await store.list();
    expect("workflows" in r && r.workflows.find((w) => w.id === "wf_x")!.steps).toEqual([{ id: "a", text: "t" }]);
  });

  it("skips corrupt, invalid, mismatched and temp files when listing", async () => {
    const { store, fs } = setup();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await store.save(doc());
    fs.files.set(at("wf_bad"), Buffer.from("{nope"));
    fs.files.set(at("wf_inv"), Buffer.from(JSON.stringify({ id: "wf_inv" })));
    fs.files.set(at("wf_other"), Buffer.from(JSON.stringify(doc({ id: "wf_d2" }))));
    fs.files.set(`${at("wf_d1")}.123.tmp`, Buffer.from(JSON.stringify(doc({ id: "wf_d1", rev: 9 }))));
    expect(await store.list()).toEqual({ workflows: [doc()], deleted: [] });
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
    a.fs.files.set(at("wf_d1"), Buffer.from(JSON.stringify(doc({ rev: 5 }))));
    expect(await a.store.save(doc({ rev: 4 }))).toEqual({ ok: true, stale: true, rev: 5 });
    expect(await a.store.save(doc({ rev: 4 }))).toEqual({ ok: true, stale: true, rev: 5 });
    expect(a.fs.reads).toBe(1);
    const b = setup();
    b.fs.files.set(at("wf_d1"), Buffer.from(JSON.stringify(doc({ rev: 5 }))));
    await b.store.list();
    b.fs.reads = 0;
    expect(await b.store.save(doc({ rev: 5 }))).toEqual({ ok: true, stale: true, rev: 5 });
    expect(b.fs.reads).toBe(0);
  });

  it("remove clears the cached rev", async () => {
    const { store, fs } = setup();
    await store.save(doc({ rev: 7 }));
    await store.remove("wf_d1");
    fs.reads = 0;
    expect(await store.save(doc({ rev: 8 }))).toEqual({ ok: true, rev: 8 });
    expect(fs.reads).toBe(1);
  });

  it("list sweeps temp files older than an hour and keeps fresh ones", async () => {
    const { store, fs, clock } = setup();
    const old = `${at("wf_d1")}.1.tmp`;
    const fresh = `${at("wf_d2")}.2.tmp`;
    fs.files.set(old, Buffer.from("x"));
    fs.mtimes.set(old, clock.t - 3_600_000 - 1);
    fs.files.set(fresh, Buffer.from("x"));
    fs.mtimes.set(fresh, clock.t - 1000);
    expect(await store.list()).toEqual({ workflows: [], deleted: [] });
    expect(fs.files.has(old)).toBe(false);
    expect(fs.files.has(fresh)).toBe(true);
  });

  it("a failing sweep is logged and does not fail list", async () => {
    const { store, fs } = setup();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const old = `${at("wf_d1")}.1.tmp`;
    fs.files.set(old, Buffer.from("x"));
    fs.remove = async () => {
      throw new Error("EPERM");
    };
    await store.save(doc({ id: "wf_d3" }));
    expect(await store.list()).toEqual({ workflows: [doc({ id: "wf_d3" })], deleted: [] });
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("a corrupt stored file is replaced by the next save", async () => {
    const { store, fs } = setup();
    fs.files.set(at("wf_d1"), Buffer.from("garbage"));
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
    expect(await store.remove("wf_d1")).toHaveProperty("error");
    // the chain survives a failure
    fs.fail = undefined;
    expect(await store.save(doc())).toEqual({ ok: true, rev: 1 });
  });

  describe("tombstones", () => {
    const TOMB = path.join(ROOT, ".deleted.json");
    const tombs = (fs: ReturnType<typeof memFs>) => JSON.parse(fs.files.get(TOMB)!.toString());

    it("remove records a tombstone with the stored rev; list returns it and never reads it as a document", async () => {
      const { store, fs, clock } = setup();
      await store.save(doc({ rev: 4 }));
      expect(await store.remove("wf_d1")).toEqual({ ok: true });
      expect(tombs(fs)).toEqual([{ id: "wf_d1", rev: 4, at: clock.t }]);
      expect(await store.list()).toEqual({ workflows: [], deleted: [{ id: "wf_d1", rev: 4 }] });
    });

    it("removing a document that was never stored records nothing", async () => {
      const { store, fs } = setup();
      expect(await store.remove("wf_nope")).toEqual({ ok: true });
      expect(fs.files.has(TOMB)).toBe(false);
    });

    it("a save at or below the tombstone rev is refused as stale and writes nothing", async () => {
      const { store, fs } = setup();
      await store.save(doc({ rev: 4 }));
      await store.remove("wf_d1");
      const writes = fs.writes;
      expect(await store.save(doc({ rev: 4 }))).toEqual({ ok: true, stale: true, rev: 4 });
      expect(await store.save(doc({ rev: 2 }))).toEqual({ ok: true, stale: true, rev: 4 });
      expect(fs.writes).toBe(writes);
      expect(fs.files.has(at("wf_d1"))).toBe(false);
    });

    it("a save with a higher rev wins and clears the tombstone", async () => {
      const { store, fs } = setup();
      await store.save(doc({ rev: 4 }));
      await store.remove("wf_d1");
      expect(await store.save(doc({ rev: 5 }))).toEqual({ ok: true, rev: 5 });
      expect(tombs(fs)).toEqual([]);
      expect(await store.list()).toEqual({ workflows: [doc({ rev: 5 })], deleted: [] });
    });

    it("tombstones survive a restart (a new store reads the file)", async () => {
      const { store, fs, clock } = setup();
      await store.save(doc({ rev: 4 }));
      await store.remove("wf_d1");
      const again = createWorkflowStore({ rootDir: ROOT, fs, now: () => clock.t });
      expect(await again.save(doc({ rev: 3 }))).toEqual({ ok: true, stale: true, rev: 4 });
    });

    it("never ages tombstones out", async () => {
      const { store, fs, clock } = setup();
      await store.save(doc({ rev: 2 }));
      await store.remove("wf_d1");
      clock.t += 400 * 86_400_000;
      expect(await store.list()).toEqual({ workflows: [], deleted: [{ id: "wf_d1", rev: 2 }] });
      expect(await store.save(doc({ rev: 1 }))).toEqual({ ok: true, stale: true, rev: 2 });
      expect(tombs(fs)).toHaveLength(1);
    });

    it("caps the set at MAX_TOMBSTONES, dropping the oldest on write", async () => {
      const { store, fs, clock } = setup();
      const seed = Array.from({ length: MAX_TOMBSTONES }, (_, i) => ({ id: `wf_s${i}`, rev: 1, at: 1000 + i }));
      fs.files.set(TOMB, Buffer.from(JSON.stringify(seed)));
      await store.save(doc({ rev: 2 }));
      await store.remove("wf_d1"); // 10_001 entries -> the oldest (s0, at 1000) goes
      const ids = tombs(fs).map((t: { id: string }) => t.id);
      expect(ids).toHaveLength(MAX_TOMBSTONES);
      expect(ids).not.toContain("wf_s0");
      expect(ids).toContain("wf_s1");
      expect(ids).toContain("wf_d1");
      expect(clock.t).toBeGreaterThan(1000 + MAX_TOMBSTONES);
    });

    it("corrupt tombstone JSON or a wrong shape is an empty set (and is overwritten by the next remove)", async () => {
      for (const bad of ["{not json", '{"a":1}']) {
        const { store, fs } = setup();
        fs.files.set(TOMB, Buffer.from(bad));
        expect(await store.list()).toEqual({ workflows: [], deleted: [] });
        await store.save(doc({ rev: 2 }));
        expect(await store.remove("wf_d1")).toEqual({ ok: true });
        expect(tombs(fs).map((t: { id: string }) => t.id)).toEqual(["wf_d1"]);
      }
    });

    it("a transient read error is not cached: remove fails (doc kept), save fails, list answers deleted: []", async () => {
      const { store, fs } = setup();
      await store.save(doc({ rev: 4 }));
      await store.remove("wf_d1");
      await store.save(doc({ id: "wf_d2", rev: 1 }));
      const fresh = createWorkflowStore({ rootDir: ROOT, fs, now: () => 0 });
      fs.readFail = { re: /\.deleted\.json/, code: "EACCES" };
      expect(await fresh.remove("wf_d2")).toHaveProperty("error");
      expect(fs.files.has(at("wf_d2"))).toBe(true);
      expect(await fresh.save(doc({ rev: 9 }))).toHaveProperty("error");
      expect(fs.files.has(at("wf_d1"))).toBe(false); // no write past the tombstone check
      const listed = await fresh.list();
      expect(listed).toMatchObject({ deleted: [] });
      expect(tombs(fs)).toEqual([expect.objectContaining({ id: "wf_d1", rev: 4 })]); // never overwritten
      // Recovers once the read works: the error was not cached.
      fs.readFail = undefined;
      expect(await fresh.save(doc({ rev: 3 }))).toEqual({ ok: true, stale: true, rev: 4 });
    });

    it("a failed persist when clearing keeps the tombstone in memory; the save still answers ok", async () => {
      const { store, fs } = setup();
      await store.save(doc({ rev: 4 }));
      await store.remove("wf_d1");
      fs.fail = /\.deleted\.json/;
      expect(await store.save(doc({ rev: 5 }))).toEqual({ ok: true, rev: 5 });
      expect(fs.files.has(at("wf_d1"))).toBe(true);
      expect(tombs(fs)).toEqual([expect.objectContaining({ id: "wf_d1", rev: 4 })]);
      expect(await store.list()).toMatchObject({ deleted: [{ id: "wf_d1", rev: 4 }] }); // memory agrees with disk
    });

    it("a failed tombstone write fails the remove and keeps the document", async () => {
      const { store, fs } = setup();
      await store.save(doc());
      fs.fail = /\.deleted\.json/;
      expect(await store.remove("wf_d1")).toHaveProperty("error");
      expect(fs.files.has(at("wf_d1"))).toBe(true);
      fs.fail = undefined;
      expect(await store.save(doc({ rev: 2 }))).toEqual({ ok: true, rev: 2 });
    });
  });
});

describe("workflowDirFor", () => {
  it("uses workflows normally and workflows-dev under a PEN_DESKTOP_URL override", () => {
    expect(workflowDirFor(false)).toBe("workflows");
    expect(workflowDirFor(true)).toBe("workflows-dev");
  });
});
