import { describe, expect, it, vi } from "vitest";
import {
  IDB_TARGETS,
  applyScript,
  countsOf,
  exportScript,
  existingScript,
  isMigrationDone,
  loadCodec,
  mergeDocsIndex,
  priorAttempts,
  migrateIfNeeded,
  migrationFlagText,
  planMerge,
  runOriginMigration,
  shouldRunOriginMigration,
  type MigrationPort,
  type OriginSnapshot,
} from "../src/main/originMigration";
import { DEFAULT_EDITOR_URL, LEGACY_EDITOR_ORIGIN } from "../src/main/config";

const FROM = LEGACY_EDITOR_ORIGIN;
const TO = new URL(DEFAULT_EDITOR_URL).origin;

describe("decision", () => {
  const done = migrationFlagText(FROM, TO, { localStorage: 1, plugins: 0, fonts: 0 }, new Date(0));
  it("runs by default, skips with an override, skips when done for this pair", () => {
    expect(shouldRunOriginMigration({ overridden: false, flagText: null, from: FROM, to: TO })).toBe(true);
    expect(shouldRunOriginMigration({ overridden: true, flagText: null, from: FROM, to: TO })).toBe(false);
    expect(shouldRunOriginMigration({ overridden: false, flagText: done, from: FROM, to: TO })).toBe(false);
    expect(shouldRunOriginMigration({ overridden: false, flagText: null, from: TO, to: TO })).toBe(false);
  });
  it("a flag for another pair, a corrupt flag or done:false does not count", () => {
    expect(isMigrationDone(done, FROM, "https://other.example")).toBe(false);
    expect(isMigrationDone("{nope", FROM, TO)).toBe(false);
    expect(isMigrationDone(JSON.stringify({ from: FROM, to: TO, done: false }), FROM, TO)).toBe(false);
    expect(isMigrationDone(done, FROM, TO)).toBe(true);
  });
  it("the default editor URL is the new origin and differs from the legacy one", () => {
    expect(DEFAULT_EDITOR_URL).toBe("https://app.sideform.pro/app");
    expect(LEGACY_EDITOR_ORIGIN).toBe("https://pen-editor.onrender.com");
  });
});

describe("page codec (the code that runs inside the page)", () => {
  const { enc, dec } = loadCodec();
  it("round-trips ArrayBuffer values as tagged base64, including nested ones and large buffers", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
    const rec = { family: "Inter", fileName: "i.woff2", format: "woff2", bytes: bytes.buffer, nested: [{ b: new Uint8Array([1, 2, 3]) }] };
    const encoded = enc(rec) as { bytes: { __ab: string }; nested: { b: { __u8: string } }[] };
    expect(typeof encoded.bytes.__ab).toBe("string");
    expect(encoded.nested[0].b.__u8).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    // JSON-safe: survives the executeJavaScript string hop.
    const back = dec(JSON.parse(JSON.stringify(encoded))) as typeof rec;
    expect(new Uint8Array(back.bytes)).toEqual(bytes);
    expect(back.nested[0].b).toEqual(new Uint8Array([1, 2, 3]));
    expect(back.family).toBe("Inter");
  });
  it("leaves plain values alone", () => {
    const v = { id: "p1", n: 3, ok: true, nil: null, list: ["a", { b: 1 }] };
    expect(dec(enc(v))).toEqual(v);
  });
});

describe("planMerge", () => {
  const snap: OriginSnapshot = {
    localStorage: { "pen.userId": "u-old", "pen.docs.1": "doc", keep: "old" },
    idb: [
      { db: "pen-editor-plugins", store: "plugins", keyPath: "id", records: [{ id: "a" }, { id: "b" }, { id: "a" }] },
      { db: "pen-editor-custom-fonts", store: "fonts", keyPath: "family", records: [{ family: "Inter", bytes: { __ab: "AQI=" } }] },
    ],
  };
  it("writes only absent localStorage keys and absent IDB records", () => {
    const plan = planMerge(snap, {
      localStorageKeys: ["keep"],
      idb: [{ db: "pen-editor-plugins", store: "plugins", keys: ["b"] }, { db: "pen-editor-custom-fonts", store: "fonts", keys: [] }],
    });
    expect(plan.localStorage).toEqual([["pen.userId", "u-old"], ["pen.docs.1", "doc"]]);
    expect(plan.idb.find((e) => e.store === "plugins")!.records).toEqual([{ id: "a" }]);
    expect(plan.idb.find((e) => e.store === "fonts")!.records).toHaveLength(1);
    expect(plan.skipped).toEqual({ localStorage: 1, idb: 2 }); // "b" existing + duplicate "a"
    expect(countsOf(plan)).toEqual({ localStorage: 2, plugins: 1, fonts: 1 });
  });
  it("pen.userId from the old origin OVERWRITES a different one on the new origin; an equal one is left alone", () => {
    const old: OriginSnapshot = { localStorage: { "pen.userId": "u-old", other: "o" }, idb: [] };
    const plan = planMerge(old, { localStorageKeys: ["pen.userId", "other"], userId: "u-minted-by-failed-launch", idb: [] });
    expect(plan.localStorage).toEqual([["pen.userId", "u-old"]]);
    expect(plan.overwrite).toEqual(["pen.userId"]); // "other" stays fill-only
    expect(plan.skipped.localStorage).toBe(1);
    const same = planMerge(old, { localStorageKeys: ["pen.userId", "other"], userId: "u-old", idb: [] });
    expect(same.localStorage).toEqual([]);
    expect(same.overwrite).toEqual([]);
    expect(applyScript(plan)).toContain('"overwrite":["pen.userId"]');
  });
  it("pen.docs.index on both origins is merged: union by id, the new origin's entry wins a duplicate", () => {
    const oldIdx = [{ id: "a", title: "old a", updatedAt: 1 }, { id: "b", title: "old b", updatedAt: 2 }];
    const newIdx = [{ id: "b", title: "new b", updatedAt: 9 }, { id: "c", title: "new c", updatedAt: 3 }];
    const plan = planMerge(
      { localStorage: { "pen.docs.index": JSON.stringify(oldIdx) }, idb: [] },
      { localStorageKeys: ["pen.docs.index"], docsIndex: JSON.stringify(newIdx), idb: [] },
    );
    expect(plan.overwrite).toEqual(["pen.docs.index"]);
    expect(JSON.parse(plan.localStorage[0][1])).toEqual([newIdx[0], newIdx[1], oldIdx[0]]);
    // only on the old origin: ordinary fill
    const fill = planMerge({ localStorage: { "pen.docs.index": JSON.stringify(oldIdx) }, idb: [] }, { localStorageKeys: [], idb: [] });
    expect(fill.localStorage).toEqual([["pen.docs.index", JSON.stringify(oldIdx)]]);
    expect(fill.overwrite).toEqual([]);
    // old index unusable or nothing new to add: untouched
    expect(mergeDocsIndex("not json", JSON.stringify(newIdx))).toBeNull();
    const none = planMerge({ localStorage: { "pen.docs.index": JSON.stringify([newIdx[0]]) }, idb: [] }, { localStorageKeys: ["pen.docs.index"], docsIndex: JSON.stringify(newIdx), idb: [] });
    expect(none.localStorage).toEqual([]);
    expect(none.skipped.localStorage).toBe(1);
  });
  it("a record without its keyPath value is skipped, an empty store yields no entry", () => {
    const plan = planMerge(
      { localStorage: {}, idb: [{ db: "pen-editor-plugins", store: "plugins", keyPath: "id", records: [{ name: "x" }, null] }] },
      { localStorageKeys: [], idb: [] },
    );
    expect(plan.idb).toEqual([]);
    expect(plan.skipped.idb).toBe(2);
  });
  it("number 1 and string '1' are different keys", () => {
    const plan = planMerge(
      { localStorage: {}, idb: [{ db: "d", store: "s", keyPath: "id", records: [{ id: 1 }, { id: "1" }] }] },
      { localStorageKeys: [], idb: [{ db: "d", store: "s", keys: [1] }] },
    );
    expect(plan.idb[0].records).toEqual([{ id: "1" }]);
  });
});

describe("page scripts", () => {
  it("are syntactically valid async expressions and mention the exact IndexedDB layout", () => {
    for (const script of [exportScript(), existingScript(), applyScript({ localStorage: [["k", "v"]], overwrite: [], idb: [], skipped: { localStorage: 0, idb: 0 } })]) {
      expect(() => new Function(`return ${script}`)).not.toThrow();
    }
    expect(IDB_TARGETS).toEqual([
      { db: "pen-editor-plugins", store: "plugins", keyPath: "id", version: 1 },
      { db: "pen-editor-custom-fonts", store: "fonts", keyPath: "family", version: 1 },
    ]);
    expect(existingScript()).toContain("indexedDB.open(t.db, t.version)");
    expect(existingScript()).toContain("createObjectStore(t.store, { keyPath: t.keyPath })");
    expect(exportScript()).toContain("indexedDB.databases");
  });
  it("the export script never creates a database", () => {
    expect(exportScript()).not.toContain("createObjectStore");
    expect(exportScript()).not.toContain("open(t.db, ");
  });
  it("the apply script adds (never puts) so an existing key cannot be overwritten", () => {
    const s = applyScript({ localStorage: [], overwrite: [], idb: [{ db: "pen-editor-plugins", store: "plugins", keyPath: "id", records: [{ id: "a" }] }], skipped: { localStorage: 0, idb: 0 } });
    expect(s).toContain(".add(dec(rec))");
    expect(s).not.toContain(".put(");
    expect(s).toContain("localStorage.getItem(k) === null");
  });
});

/** A scripted port: `run` answers by which script it is given. */
function fakePort(opts: { clearFails?: boolean; snapshot?: OriginSnapshot; existing?: unknown; failLoad?: string; hang?: boolean; redirect?: { from: string; to: string } } = {}) {
  const loads: string[] = [];
  const ran: string[] = [];
  let current = "";
  const cleared: string[][] = [];
  const port: MigrationPort = {
    clearServiceWorkers: vi.fn(async (origins: string[]) => {
      ran.push("clear-sw");
      cleared.push(origins);
      if (opts.clearFails) throw new Error("clear failed");
    }),
    currentUrl: () => current,
    load: vi.fn(async (url: string) => {
      loads.push(url);
      current = opts.redirect && url.startsWith(opts.redirect.from) ? `${opts.redirect.to}/__sideform_migrate__` : url;
      if (opts.hang) return new Promise<void>(() => {});
      if (opts.failLoad && url.startsWith(opts.failLoad)) throw new Error("ERR_INTERNET_DISCONNECTED");
    }),
    run: vi.fn(async (script: string) => {
      if (script.includes("indexedDB.databases")) {
        ran.push("export");
        return JSON.stringify(opts.snapshot ?? { localStorage: {}, idb: [] });
      }
      if (script.includes("getAllKeys")) {
        ran.push("existing");
        return JSON.stringify(opts.existing ?? { localStorageKeys: [], idb: [] });
      }
      ran.push("apply");
      return "ok";
    }),
    dispose: vi.fn(),
  };
  return { port, loads, ran, cleared };
}

describe("runOriginMigration", () => {
  const snapshot: OriginSnapshot = { localStorage: { a: "1", b: "2" }, idb: [{ db: "pen-editor-plugins", store: "plugins", keyPath: "id", records: [{ id: "x" }] }] };

  it("exports from the old origin's migration page, then imports on the new one's, and disposes the window", async () => {
    const { port, loads, ran } = fakePort({ snapshot, existing: { localStorageKeys: ["b"], idb: [] } });
    const out = await runOriginMigration({ from: FROM, to: TO, makePort: () => port });
    expect(loads).toEqual([`${FROM}/__sideform_migrate__`, `${TO}/__sideform_migrate__`]);
    expect(ran).toEqual(["clear-sw", "export", "existing", "apply"]);
    expect(out).toEqual({ status: "done", counts: { localStorage: 1, plugins: 1, fonts: 0 }, skipped: { localStorage: 1, idb: 0 } });
    expect(port.dispose).toHaveBeenCalled();
  });

  it("skips the apply step when there is nothing to write", async () => {
    const { port, ran } = fakePort();
    const out = await runOriginMigration({ from: FROM, to: TO, makePort: () => port });
    expect(out.status).toBe("done");
    expect(ran).toEqual(["clear-sw", "export", "existing"]);
  });

  it("clears only service workers of BOTH origins before any load, and a failing clear does not stop the migration", async () => {
    const { port, ran, cleared } = fakePort({ clearFails: true });
    const out = await runOriginMigration({ from: FROM, to: TO, makePort: () => port });
    expect(cleared).toEqual([[FROM, TO]]);
    expect(ran[0]).toBe("clear-sw");
    expect(out.status).toBe("done");
  });

  it("an offline load failure is a failed outcome (fast), not a throw", async () => {
    const { port } = fakePort({ failLoad: FROM });
    const out = await runOriginMigration({ from: FROM, to: TO, makePort: () => port });
    expect(out).toEqual({ status: "failed", error: "ERR_INTERNET_DISCONNECTED" });
    expect(port.dispose).toHaveBeenCalled();
  });

  it("the old origin landing elsewhere is a failure (no done flag), and nothing is exported from the wrong origin", async () => {
    const { port, ran } = fakePort({ snapshot, redirect: { from: FROM, to: "https://app.sideform.pro" } });
    const out = await runOriginMigration({ from: FROM, to: TO, makePort: () => port });
    expect(out.status).toBe("failed");
    expect(ran).toEqual(["clear-sw"]);
    expect(port.dispose).toHaveBeenCalled();
  });

  it("the new origin redirecting elsewhere is a failure (retry), and nothing is applied", async () => {
    const { port, ran } = fakePort({ snapshot, redirect: { from: TO, to: "https://elsewhere.example" } });
    const out = await runOriginMigration({ from: FROM, to: TO, makePort: () => port });
    expect(out.status).toBe("failed");
    expect(ran).toEqual(["clear-sw", "export"]);
  });

  it("a port that cannot even be created is a failed outcome", async () => {
    const out = await runOriginMigration({ from: FROM, to: TO, makePort: () => { throw new Error("no window"); } });
    expect(out).toEqual({ status: "failed", error: "no window" });
  });

  it("times out at the deadline when a load hangs, and disposes the window", async () => {
    vi.useFakeTimers();
    try {
      const { port } = fakePort({ hang: true });
      const p = runOriginMigration({ from: FROM, to: TO, makePort: () => port, timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(4_999);
      let settled = false;
      void p.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toEqual({ status: "timeout" });
      expect(port.dispose).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("migrateIfNeeded (flag file)", () => {
  const mkFs = (initial: string | null = null) => {
    const files = new Map<string, string>();
    if (initial !== null) files.set("/ud/origin-migration.json", initial);
    return { files, read: (p: string) => files.get(p) ?? null, write: (p: string, t: string) => void files.set(p, t) };
  };
  const base = (fs: ReturnType<typeof mkFs>, port: MigrationPort, extra: Partial<Parameters<typeof migrateIfNeeded>[0]> = {}) => ({
    overridden: false, from: FROM, to: TO, flagPath: "/ud/origin-migration.json", fs, makePort: () => port, now: () => new Date("2026-10-20T00:00:00Z"), log: vi.fn(), ...extra,
  });

  it("writes the done flag with counts on success and then skips", async () => {
    const fs = mkFs();
    const { port } = fakePort({ snapshot: { localStorage: { a: "1" }, idb: [] } });
    expect((await migrateIfNeeded(base(fs, port))) !== "skipped").toBe(true);
    const flag = JSON.parse(fs.files.get("/ud/origin-migration.json")!);
    expect(flag).toMatchObject({ from: FROM, to: TO, done: true, counts: { localStorage: 1, plugins: 0, fonts: 0 } });
    expect(await migrateIfNeeded(base(fs, port))).toBe("skipped");
  });

  it("failure and timeout leave NO done flag but count attempts; the third failure writes a terminal record and stops retrying", async () => {
    const fs = mkFs();
    const flag = () => JSON.parse(fs.files.get("/ud/origin-migration.json")!);
    const { port } = fakePort({ failLoad: TO });
    expect(await migrateIfNeeded(base(fs, port))).toMatchObject({ status: "failed" });
    expect(flag()).toMatchObject({ from: FROM, to: TO, done: false, attempts: 1, lastError: "ERR_INTERNET_DISCONNECTED" });
    expect(isMigrationDone(fs.files.get("/ud/origin-migration.json")!, FROM, TO)).toBe(false);
    const hang = fakePort({ hang: true });
    expect(await migrateIfNeeded(base(fs, hang.port, { timeoutMs: 5 }))).toEqual({ status: "timeout" });
    expect(flag()).toMatchObject({ done: false, attempts: 2, lastError: "timeout" });
    expect(await migrateIfNeeded(base(fs, fakePort({ failLoad: FROM }).port))).toMatchObject({ status: "failed" });
    expect(flag()).toMatchObject({ from: FROM, to: TO, done: true, failed: true, attempts: 3, lastError: "ERR_INTERNET_DISCONNECTED" });
    // Terminal: no fourth attempt, no window.
    const makePort = vi.fn();
    expect(await migrateIfNeeded({ ...base(fs, port), makePort })).toBe("skipped");
    expect(makePort).not.toHaveBeenCalled();
  });

  it("a counter from another from/to pair is not carried over", () => {
    expect(priorAttempts(JSON.stringify({ from: "x", to: TO, attempts: 2 }), FROM, TO)).toBe(0);
    expect(priorAttempts(JSON.stringify({ from: FROM, to: TO, attempts: 2 }), FROM, TO)).toBe(2);
    expect(priorAttempts("not json", FROM, TO)).toBe(0);
  });

  it("an override never runs and never creates a window", async () => {
    const fs = mkFs();
    const makePort = vi.fn();
    expect(await migrateIfNeeded({ ...base(fs, fakePort().port), overridden: true, makePort })).toBe("skipped");
    expect(makePort).not.toHaveBeenCalled();
  });

  it("a failing flag write is logged and does not throw", async () => {
    const fs = { read: () => null, write: () => { throw new Error("EROFS"); } };
    const log = vi.fn();
    const out = await migrateIfNeeded({ ...base(mkFs(), fakePort().port), fs, log });
    expect(out).not.toBe("skipped");
    expect(log.mock.calls.some((c) => String(c[0]).includes("EROFS"))).toBe(true);
  });
});
