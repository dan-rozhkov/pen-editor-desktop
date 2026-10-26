import { describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import {
  createTraceStore,
  MAX_ASSET_BYTES,
  MAX_ASSETS,
  MAX_DOM_BYTES,
  MAX_MANIFEST_BYTES,
  type TraceFs,
} from "../src/main/traceStore";

const ROOT = "/ud/browse-traces";

/** In-memory async fs port: files by absolute path, a fake clock for directory mtimes. */
function memFs() {
  const files = new Map<string, Buffer>();
  const mtimes = new Map<string, number>(); // top-level dir -> mtime
  let clock = 1;
  const topDir = (p: string) => path.relative(ROOT, p).split(path.sep)[0]!;
  const under = (dir: string) => [...files.keys()].filter((p) => p === dir || p.startsWith(dir + path.sep));
  const api: TraceFs & { files: Map<string, Buffer>; failWritesMatching?: RegExp } = {
    files,
    read: async (p) => files.get(p) ?? null,
    async write(p, data) {
      if (api.failWritesMatching?.test(p)) throw new Error("disk full");
      files.set(p, data);
      mtimes.set(topDir(p), clock++);
    },
    listDirs: async (dir) => {
      const names = new Set<string>();
      for (const p of files.keys()) if (p.startsWith(dir + path.sep)) names.add(topDir(p));
      return [...names].map((name) => ({ name, mtimeMs: mtimes.get(name) ?? 0 }));
    },
    dirExists: async (dir) => under(dir).length > 0,
    async renameDir(from, to) {
      if (under(to).length > 0) throw new Error("ENOTEMPTY");
      for (const p of under(from)) {
        files.set(to + p.slice(from.length), files.get(p)!);
        files.delete(p);
      }
      mtimes.set(topDir(to), mtimes.get(topDir(from)) ?? clock++);
    },
    async removeDir(dir) {
      for (const p of under(dir)) files.delete(p);
    },
  };
  return api;
}

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

function manifest(id = "t1", frames: { id: number; src: string }[] = [{ id: 0, src: "frames/0.jpg" }]) {
  return {
    format: "sideform.browse-trace",
    version: 1,
    id,
    goal: "find pricing",
    startedAt: 1,
    endedAt: 2,
    status: "completed",
    steps: [{ index: 0, tool: "browse_open", args: {}, startedAt: 1, endedAt: 2, ok: true }],
    frames: frames.map((f) => ({ ...f, at: 1, kind: "step" })),
    console: [],
    network: [],
  };
}
const payload = (m = manifest(), assets = [{ path: "frames/0.jpg", dataUrl: JPG }]) => ({ manifest: m, assets });

function store(io = memFs(), maxTraces?: number) {
  return { io, store: createTraceStore({ rootDir: ROOT, fs: io, maxTraces }) };
}

describe("traceStore.save", () => {
  it("writes frames then trace.json under <root>/<id>/ and returns the id", async () => {
    const { io, store: s } = store();
    expect(await s.save(payload())).toEqual({ id: "t1" });
    expect([...io.files.keys()].sort()).toEqual([`${ROOT}/t1/frames/0.jpg`, `${ROOT}/t1/trace.json`]);
    expect(io.files.get(`${ROOT}/t1/frames/0.jpg`)).toEqual(Buffer.from(JPG.split(",")[1]!, "base64"));
    expect(JSON.parse(io.files.get(`${ROOT}/t1/trace.json`)!.toString()).frames[0].src).toBe("frames/0.jpg");
  });

  it("saves a trace without frames", async () => {
    const s = store().store;
    expect(await s.save({ manifest: manifest("empty", []), assets: [] })).toEqual({ id: "empty" });
  });

  it("rejects a bad payload, manifest, id and assets array without writing", async () => {
    const { io, store: s } = store();
    for (const bad of [null, "x", [], {}, { manifest: {}, assets: [] }, { manifest: manifest("../evil"), assets: [] }, { manifest: manifest("a b"), assets: [] }]) {
      expect(await s.save(bad), JSON.stringify(bad)).toHaveProperty("error");
    }
    expect(await s.save({ manifest: manifest(), assets: "no" })).toHaveProperty("error");
    expect(io.files.size).toBe(0);
  });

  it("rejects asset paths that escape or do not match the frame pattern", async () => {
    const { io, store: s } = store();
    for (const p of ["../x.jpg", "frames/../x.jpg", "/etc/passwd", "frames/0.gif", "frames/a.jpg", "frames/0.jpg/../1.jpg", "trace.json", "frames/00000.jpg"]) {
      expect(await s.save(payload(manifest("t1", [{ id: 0, src: p }]), [{ path: p, dataUrl: JPG }])), p).toHaveProperty("error");
    }
    expect(io.files.size).toBe(0);
  });

  it("rejects data URLs that are not images, do not match the extension, or are malformed", async () => {
    const { store: s } = store();
    for (const dataUrl of ["data:text/html;base64,AAAA", "http://x/a.jpg", PNG, "data:image/jpeg;base64,@@@", "data:image/svg+xml;base64,AAAA", 5]) {
      expect(await s.save(payload(manifest(), [{ path: "frames/0.jpg", dataUrl: dataUrl as string }])), String(dataUrl)).toHaveProperty("error");
    }
  });

  it("requires every frame to have an asset and every asset to be referenced", async () => {
    const { io, store: s } = store();
    expect(await s.save(payload(manifest("t1", [{ id: 0, src: "frames/0.jpg" }, { id: 1, src: "frames/1.jpg" }])))).toHaveProperty("error");
    expect(await s.save(payload(manifest(), [{ path: "frames/0.jpg", dataUrl: JPG }, { path: "frames/1.png", dataUrl: PNG }]))).toHaveProperty("error");
    expect(await s.save(payload(manifest("t1", [{ id: 0, src: "https://x/y.jpg" }]), []))).toHaveProperty("error");
    expect(io.files.size).toBe(0);
  });

  it("rejects duplicate asset paths", async () => {
    const { store: s } = store();
    expect(await s.save(payload(manifest(), [{ path: "frames/0.jpg", dataUrl: JPG }, { path: "frames/0.jpg", dataUrl: JPG }]))).toHaveProperty("error");
  });

  it("caps the number of assets", async () => {
    const { store: s } = store();
    const n = MAX_ASSETS + 1;
    const frames = Array.from({ length: n }, (_, i) => ({ id: i, src: `frames/${i}.jpg` }));
    const assets = frames.map((f) => ({ path: f.src, dataUrl: JPG }));
    expect(await s.save(payload(manifest("t1", frames), assets))).toEqual({ error: "too many assets" });
    const ok = frames.slice(0, MAX_ASSETS);
    expect(await s.save(payload(manifest("t1", ok), assets.slice(0, MAX_ASSETS)))).toEqual({ id: "t1" });
  });

  it("caps one asset at 3 MB decoded", async () => {
    const { store: s } = store();
    const big = (bytes: number) => `data:image/jpeg;base64,${Buffer.alloc(bytes, 1).toString("base64")}`;
    expect(await s.save(payload(manifest(), [{ path: "frames/0.jpg", dataUrl: big(MAX_ASSET_BYTES + 1) }]))).toHaveProperty("error");
    expect(await s.save(payload(manifest(), [{ path: "frames/0.jpg", dataUrl: big(MAX_ASSET_BYTES) }]))).toEqual({ id: "t1" });
  });

  it("caps the manifest at 4 MB", async () => {
    const { io, store: s } = store();
    const m = manifest();
    m.goal = "x".repeat(MAX_MANIFEST_BYTES);
    expect(await s.save(payload(m))).toEqual({ error: "manifest too large" });
    expect(io.files.size).toBe(0);
  });

  it("removes the half-written directory when a write fails", async () => {
    const { io, store: s } = store();
    io.failWritesMatching = /trace\.json$/;
    expect(await s.save(payload())).toHaveProperty("error");
    expect(io.files.size).toBe(0);
  });

  it("is write-once: a second save of an existing id fails and leaves the first untouched", async () => {
    const { io, store: s } = store();
    expect(await s.save(payload())).toEqual({ id: "t1" });
    const before = new Map(io.files);
    const other = manifest("t1");
    other.goal = "different";
    expect(await s.save(payload(other))).toEqual({ error: "trace exists" });
    expect(io.files).toEqual(before);
  });

  it("a failed new save leaves no temp directory and does not touch other traces", async () => {
    const { io, store: s } = store();
    await s.save(payload(manifest("keep")));
    const before = new Map(io.files);
    io.failWritesMatching = /t2/;
    expect(await s.save(payload(manifest("t2")))).toHaveProperty("error");
    expect(io.files).toEqual(before);
  });

  it("builds in a temp sibling and only renames it into place at the end", async () => {
    const { io, store: s } = store();
    const seen: string[] = [];
    const rename = io.renameDir;
    io.renameDir = async (from, to) => {
      seen.push(`${path.basename(from).startsWith(".tmp-t1-")}:${io.files.has(`${to}/trace.json`)}:${io.files.has(`${from}/trace.json`)}`);
      return rename(from, to);
    };
    await s.save(payload());
    expect(seen).toEqual(["true:false:true"]);
  });

  it("a lost race for the id (rename fails) cleans up its own temp directory", async () => {
    const { io, store: s } = store();
    io.renameDir = async () => { throw new Error("ENOTEMPTY"); };
    expect(await s.save(payload())).toHaveProperty("error");
    expect(io.files.size).toBe(0);
  });

  it("sweeps stale unfinished temp directories, keeps fresh ones", async () => {
    const io = memFs();
    let t = 1_000;
    const s = createTraceStore({ rootDir: ROOT, fs: io, now: () => t });
    io.files.set(`${ROOT}/.tmp-old-aa/x`, Buffer.from("x"));
    await io.write(`${ROOT}/.tmp-old-aa/y`, Buffer.from("y")); // mtime 1
    t = 1 + 2 * 60 * 60 * 1000;
    await s.save(payload());
    expect([...io.files.keys()].some((p) => p.includes(".tmp-old-aa"))).toBe(false);
  });

  it("rejects an oversized data URL by length before matching it, and an oversized payload overall", async () => {
    const { store: s } = store();
    const huge = "data:image/jpeg;base64," + "A".repeat(Math.ceil((MAX_ASSET_BYTES * 4) / 3) + 100);
    expect(await s.save(payload(manifest(), [{ path: "frames/0.jpg", dataUrl: huge }]))).toHaveProperty("error");
    const frames = Array.from({ length: 20 }, (_, i) => ({ id: i, src: `frames/${i}.jpg` }));
    const big = "data:image/jpeg;base64," + "A".repeat(Math.floor((MAX_ASSET_BYTES * 4) / 3) - 8);
    const r = await s.save(payload(manifest("t1", frames), frames.map((f) => ({ path: f.src, dataUrl: big }))));
    expect(r).toEqual({ error: "payload too large" });
  });

  it("accepts an upper-case MIME like the package's splitTraceAssets does", async () => {
    const { store: s } = store();
    const up = JPG.replace("image/jpeg", "IMAGE/JPEG");
    expect(await s.save(payload(manifest(), [{ path: "frames/0.jpg", dataUrl: up }]))).toEqual({ id: "t1" });
    const r = await s.read("t1");
    expect("trace" in r && r.trace.frames[0]!.src).toBe(JPG);
  });

  it("keeps the newest N traces and deletes older directories", async () => {
    const { io, store: s } = store(memFs(), 3);
    for (const id of ["a", "b", "c", "d", "e"]) await s.save(payload(manifest(id)));
    const dirs = new Set([...io.files.keys()].map((p) => path.relative(ROOT, p).split(path.sep)[0]));
    expect([...dirs].sort()).toEqual(["c", "d", "e"]);
  });

  it("never prunes the trace it just saved, and ignores directories that are not trace ids", async () => {
    const { io, store: s } = store(memFs(), 1);
    io.files.set(`${ROOT}/not a trace/x`, Buffer.from("x"));
    await s.save(payload(manifest("a")));
    await s.save(payload(manifest("b")));
    const dirs = new Set([...io.files.keys()].map((p) => path.relative(ROOT, p).split(path.sep)[0]));
    expect([...dirs].sort()).toEqual(["b", "not a trace"]);
  });
});

describe("traceStore.read", () => {
  it("returns the manifest with frame src as data URLs", async () => {
    const { store: s } = store();
    await s.save(payload(manifest("t1", [{ id: 0, src: "frames/0.jpg" }, { id: 1, src: "frames/1.png" }]), [{ path: "frames/0.jpg", dataUrl: JPG }, { path: "frames/1.png", dataUrl: PNG }]));
    const r = await s.read("t1");
    expect(r).toHaveProperty("trace");
    if (!("trace" in r)) return;
    expect(r.trace.goal).toBe("find pricing");
    expect(r.trace.frames.map((f) => f.src)).toEqual([JPG, PNG]);
  });

  it("{ frames: false } keeps the asset paths and reads no frame file", async () => {
    const { io, store: s } = store();
    await s.save(payload(manifest("t1", [{ id: 0, src: "frames/0.jpg" }, { id: 1, src: "frames/1.png" }]), [{ path: "frames/0.jpg", dataUrl: JPG }, { path: "frames/1.png", dataUrl: PNG }]));
    const reads: string[] = [];
    const orig = io.read;
    io.read = async (p) => {
      reads.push(p);
      return orig(p);
    };
    const r = await s.read("t1", { frames: false });
    if (!("trace" in r)) throw new Error("expected a trace");
    expect(r.trace.frames.map((f) => f.src)).toEqual(["frames/0.jpg", "frames/1.png"]);
    expect(reads).toHaveLength(1); // trace.json only
    const full = await s.read("t1", { frames: true });
    if (!("trace" in full)) throw new Error("expected a trace");
    expect(full.trace.frames.map((f) => f.src)).toEqual([JPG, PNG]);
  });

  it("{ frames: true, frameIds } inlines only those frames and reads only their files", async () => {
    const { io, store: s } = store();
    await s.save(payload(manifest("t1", [{ id: 0, src: "frames/0.jpg" }, { id: 1, src: "frames/1.png" }]), [{ path: "frames/0.jpg", dataUrl: JPG }, { path: "frames/1.png", dataUrl: PNG }]));
    const reads: string[] = [];
    const orig = io.read;
    io.read = async (p) => {
      reads.push(p);
      return orig(p);
    };
    const r = await s.read("t1", { frames: true, frameIds: [1] });
    if (!("trace" in r)) throw new Error("expected a trace");
    expect(r.trace.frames.map((f) => f.src)).toEqual(["frames/0.jpg", PNG]);
    expect(reads).toHaveLength(2); // trace.json + frame 1
    const none = await s.read("t1", { frames: true, frameIds: [] });
    if (!("trace" in none)) throw new Error("expected a trace");
    expect(none.trace.frames.map((f) => f.src)).toEqual(["frames/0.jpg", "frames/1.png"]);
    const off = await s.read("t1", { frames: false, frameIds: [1] });
    if (!("trace" in off)) throw new Error("expected a trace");
    expect(off.trace.frames.map((f) => f.src)).toEqual(["frames/0.jpg", "frames/1.png"]);
  });

  it("rejects ids that are not trace ids before touching the fs", async () => {
    const { io, store: s } = store();
    io.read = async () => { throw new Error("must not read"); };
    for (const bad of ["", "../t1", "a/b", "a".repeat(65), 5, null, undefined]) {
      expect(await s.read(bad), String(bad)).toEqual({ error: "invalid trace id" });
    }
  });

  it("reports a missing trace", async () => {
    expect(await store().store.read("nope")).toEqual({ error: "trace not found" });
  });

  it("reports corrupt JSON, a wrong format, an id mismatch and a missing frame file without throwing", async () => {
    const { io, store: s } = store();
    io.files.set(`${ROOT}/bad/trace.json`, Buffer.from("{nope"));
    expect(await s.read("bad")).toHaveProperty("error");
    io.files.set(`${ROOT}/old/trace.json`, Buffer.from(JSON.stringify({ format: "other" })));
    expect(await s.read("old")).toHaveProperty("error");
    io.files.set(`${ROOT}/liar/trace.json`, Buffer.from(JSON.stringify(manifest("someone-else", []))));
    expect(await s.read("liar")).toEqual({ error: "invalid trace: id mismatch" });
    await s.save(payload());
    io.files.delete(`${ROOT}/t1/frames/0.jpg`);
    expect(await s.read("t1")).toHaveProperty("error");
  });

  it("refuses a stored manifest whose frame src escapes the frames directory", async () => {
    const { io, store: s } = store();
    io.files.set(`${ROOT}/evil/trace.json`, Buffer.from(JSON.stringify(manifest("evil", [{ id: 0, src: "../../../etc/passwd" }]))));
    expect(await s.read("evil")).toHaveProperty("error");
  });

  it("turns an fs failure into {error}", async () => {
    const { io, store: s } = store();
    io.read = async () => { throw new Error("EACCES"); };
    expect(await s.read("t1")).toEqual({ error: "could not read trace: EACCES" });
  });
});

describe("traceStore.list", () => {
  const withManifest = (id: string, over: Record<string, unknown>) => ({ ...manifest(id), ...over });
  const save = (s: ReturnType<typeof store>["store"], m: ReturnType<typeof manifest>) => s.save(payload(m));

  it("returns summaries newest first (ties by id), goal capped, qaOutcome only when a string, no frames/steps", async () => {
    const { store: s } = store();
    await save(s, withManifest("a", { startedAt: 10, goal: "x".repeat(300) }) as never);
    await save(s, withManifest("c", { startedAt: 20 }) as never);
    await save(s, withManifest("b", { startedAt: 20, qa: { outcome: "passed", verdict: "pass", steps: [] } }) as never);
    const r = await s.list();
    if (!("traces" in r)) throw new Error("expected traces");
    expect(r.traces.map((t) => t.id)).toEqual(["b", "c", "a"]);
    expect(r.traces[2]!.goal).toHaveLength(200);
    expect(r.traces[0]!.qaOutcome).toBe("passed");
    expect(r.traces[1]).not.toHaveProperty("qaOutcome");
    expect(Object.keys(r.traces[1]!).sort()).toEqual(["goal", "id", "startedAt", "status"]);
  });

  it("skips invalid manifests and temp dirs", async () => {
    const { io, store: s } = store();
    await s.save(payload());
    io.files.set(`${ROOT}/bad/trace.json`, Buffer.from("{nope"));
    io.files.set(`${ROOT}/.tmp-t9-abc/trace.json`, Buffer.from(JSON.stringify(manifest("t9"))));
    io.files.set(`${ROOT}/nofile/frames/0.jpg`, Buffer.from("x"));
    io.files.set(`${ROOT}/other/trace.json`, Buffer.from(JSON.stringify(manifest("t1")))); // id mismatch
    const r = await s.list();
    if (!("traces" in r)) throw new Error("expected traces");
    expect(r.traces.map((t) => t.id)).toEqual(["t1"]);
  });

  it("caches summaries: a second call reads no manifest; a deleted dir drops out", async () => {
    const { io, store: s } = store();
    await s.save(payload(manifest("t1")));
    await s.save(payload(manifest("t2")));
    await s.list();
    const reads: string[] = [];
    const orig = io.read;
    io.read = async (p) => {
      reads.push(p);
      return orig(p);
    };
    const again = await s.list();
    expect(reads).toEqual([]);
    if (!("traces" in again)) throw new Error("expected traces");
    expect(again.traces).toHaveLength(2);
    await io.removeDir(`${ROOT}/t1`);
    const after = await s.list();
    if (!("traces" in after)) throw new Error("expected traces");
    expect(after.traces.map((t) => t.id)).toEqual(["t2"]);
    await s.save(payload(manifest("t3")));
    reads.length = 0;
    await s.list();
    expect(reads).toEqual([`${ROOT}/t3/trace.json`]);
  });

  it("caches bad dirs too: not re-read (nor re-warned) on the second call; re-read when the mtime changes", async () => {
    const { io, store: s } = store();
    await s.save(payload(manifest("t1")));
    io.files.set(`${ROOT}/bad/trace.json`, Buffer.from("{nope"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await s.list();
      expect(warn).toHaveBeenCalledTimes(1);
      const reads: string[] = [];
      const orig = io.read;
      io.read = async (p) => {
        reads.push(p);
        return orig(p);
      };
      await s.list();
      expect(reads).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      // fix the dir: a write bumps its mtime, so it is read again and now valid
      await io.write(`${ROOT}/bad/trace.json`, Buffer.from(JSON.stringify(manifest("bad"))));
      const r = await s.list();
      expect(reads).toEqual([`${ROOT}/bad/trace.json`]);
      if (!("traces" in r)) throw new Error("expected traces");
      expect(r.traces.map((t) => t.id).sort()).toEqual(["bad", "t1"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("never throws: a failing listDirs gives an error value", async () => {
    const io = memFs();
    io.listDirs = async () => {
      throw new Error("EIO");
    };
    const r = await createTraceStore({ rootDir: ROOT, fs: io }).list();
    expect(r).toEqual({ error: "could not list traces: EIO" });
  });
});

describe("traceStore DOM assets", () => {
  const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64");
  const HTML = `data:text/html;base64,${b64("<p>héllo</p>")}`;
  const TXT = `data:text/plain;charset=utf-8;base64,${b64("button [1] Pay")}`;
  const withDoms = (id = "t1") => ({
    ...manifest(id),
    doms: [
      { id: 0, at: 1, stepIndex: 0, kind: "html", src: "dom/0.html", bytes: 12 },
      { id: 1, at: 2, stepIndex: 0, kind: "ax", src: "dom/1.txt", bytes: 14 },
    ],
  });
  const assets = (over: Record<string, string> = {}) => [
    { path: "frames/0.jpg", dataUrl: JPG },
    { path: "dom/0.html", dataUrl: over["dom/0.html"] ?? HTML },
    { path: "dom/1.txt", dataUrl: over["dom/1.txt"] ?? TXT },
  ];

  it("round-trips html and txt (charset param allowed): files written, read inlines the right MIME", async () => {
    const { io, store: s } = store();
    expect(await s.save({ manifest: withDoms(), assets: assets() })).toEqual({ id: "t1" });
    expect(io.files.get(`${ROOT}/t1/dom/0.html`)!.toString()).toBe("<p>héllo</p>");
    expect(io.files.get(`${ROOT}/t1/dom/1.txt`)!.toString()).toBe("button [1] Pay");
    const r = await s.read("t1");
    if (!("trace" in r)) throw new Error("expected a trace");
    expect(r.trace.doms!.map((d) => d.src)).toEqual([`data:text/html;base64,${b64("<p>héllo</p>")}`, `data:text/plain;base64,${b64("button [1] Pay")}`]);
  });

  it("rejects a MIME that does not match the extension, and an image under dom/", async () => {
    const { store: s } = store();
    expect(await s.save({ manifest: withDoms(), assets: assets({ "dom/0.html": `data:text/plain;base64,${b64("x")}` }) })).toHaveProperty("error");
    expect(await s.save({ manifest: withDoms(), assets: assets({ "dom/1.txt": HTML }) })).toHaveProperty("error");
    expect(await s.save({ manifest: withDoms(), assets: assets({ "dom/0.html": PNG }) })).toHaveProperty("error");
  });

  it("caps one DOM asset at 2 MB decoded (frames keep 3 MB)", async () => {
    const { io, store: s } = store();
    const big = `data:text/html;base64,${Buffer.alloc(MAX_DOM_BYTES + 1, 0x61).toString("base64")}`;
    expect(await s.save({ manifest: withDoms(), assets: assets({ "dom/0.html": big }) })).toHaveProperty("error");
    expect(io.files.size).toBe(0);
    const ok = `data:text/html;base64,${Buffer.alloc(MAX_DOM_BYTES, 0x61).toString("base64")}`;
    expect(await s.save({ manifest: withDoms(), assets: assets({ "dom/0.html": ok }) })).toEqual({ id: "t1" });
  });

  it("requires a file for a dom stored as an asset path, and a dom for every dom file", async () => {
    const { store: s } = store();
    expect(await s.save({ manifest: withDoms(), assets: assets().slice(0, 2) })).toHaveProperty("error");
    expect(await s.save({ manifest: manifest(), assets: assets() })).toHaveProperty("error");
  });

  it("rejects dom paths that escape or have another extension", async () => {
    const { store: s } = store();
    for (const p of ["dom/../x.html", "dom/0.js", "dom/a.html", "dom/0.html/../1.html", "doms/0.html"]) {
      expect(await s.save({ manifest: withDoms(), assets: [...assets(), { path: p, dataUrl: HTML }] }), p).toHaveProperty("error");
    }
  });

  it("a partial read keeps dom asset paths and reads no dom file; only a full read inlines them", async () => {
    const { io, store: s } = store();
    await s.save({ manifest: withDoms(), assets: assets() });
    const reads: string[] = [];
    const orig = io.read;
    io.read = async (p) => {
      reads.push(p);
      return orig(p);
    };
    for (const opts of [{ frames: false }, { frames: true, frameIds: [0] }]) {
      reads.length = 0;
      const r = await s.read("t1", opts);
      if (!("trace" in r)) throw new Error("expected a trace");
      expect(r.trace.doms!.map((d) => d.src)).toEqual(["dom/0.html", "dom/1.txt"]);
      expect(reads.some((p) => p.includes("/dom/"))).toBe(false);
    }
    const full = await s.read("t1");
    if (!("trace" in full)) throw new Error("expected a trace");
    expect(full.trace.doms![0]!.src.startsWith("data:text/html;base64,")).toBe(true);
  });

  it("reports a missing dom file on a full read", async () => {
    const { io, store: s } = store();
    await s.save({ manifest: withDoms(), assets: assets() });
    io.files.delete(`${ROOT}/t1/dom/1.txt`);
    expect(await s.read("t1")).toHaveProperty("error");
  });
});
