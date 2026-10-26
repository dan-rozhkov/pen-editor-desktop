import { describe, it, expect, vi } from "vitest";
import {
  AD_BLOCK_PARTITION,
  createAdBlockController,
  createEngineManager,
  createFixtureBypassRegistry,
  createRequestListener,
  ENGINE_CACHE_MAX_AGE_MS,
  ENGINE_RETRY_MS,
  ENGINE_LOAD_TIMEOUT_MS,
  ENGINE_REFRESH_CHECK_MS,
  FIXTURE_BYPASS_MAX_MS,
  awaitSettled,
  isAdBlockCacheStale,
  requireRestoringEnv,
  isAdBlockPartition,
  loadAdBlockEngine,
  type BlockerPort,
  type RequestListener,
} from "../src/main/browser/adBlock";

function fakeWebRequest() {
  const calls: unknown[][] = [];
  let listener: RequestListener | null = null;
  return {
    calls,
    get listener() {
      return listener;
    },
    port: {
      onBeforeRequest(...args: unknown[]) {
        calls.push(args);
        listener = args.length === 2 ? (args[1] as RequestListener | null) : (args[0] as null);
      },
    } as never,
  };
}

const blocker = (cancel: boolean): BlockerPort & { seen: unknown[] } => {
  const seen: unknown[] = [];
  return { seen, onBeforeRequest: (d: unknown, cb: (r: object) => void) => (seen.push(d), cb(cancel ? { cancel: true } : {})) } as never;
};

describe("isAdBlockPartition", () => {
  it("accepts only the shared browser partition", () => {
    expect(isAdBlockPartition(AD_BLOCK_PARTITION)).toBe(true);
    expect(isAdBlockPartition("qa-0")).toBe(false);
    expect(isAdBlockPartition("persist:other")).toBe(false);
    expect(isAdBlockPartition(undefined)).toBe(false);
  });
});

describe("createRequestListener", () => {
  it("never blocks a main-frame navigation", () => {
    const b = blocker(true);
    const cb = vi.fn();
    createRequestListener(b)({ url: "https://ads.example/", resourceType: "mainFrame" }, cb);
    expect(cb).toHaveBeenCalledWith({});
    expect(b.seen).toHaveLength(0);
  });
  it("delegates subresources to the blocker", () => {
    const cb = vi.fn();
    createRequestListener(blocker(true))({ url: "https://ads.example/a.js", resourceType: "script" }, cb);
    expect(cb).toHaveBeenCalledWith({ cancel: true });
  });
  it("passes every request while shouldBypass() is true, subresources included", () => {
    const b = blocker(true);
    const cb = vi.fn();
    let bypass = true;
    const l = createRequestListener(b, () => bypass);
    l({ url: "https://ads.example/a.js", resourceType: "script" }, cb);
    expect(cb).toHaveBeenLastCalledWith({});
    expect(b.seen).toHaveLength(0);
    bypass = false;
    l({ url: "https://ads.example/a.js", resourceType: "script" }, cb);
    expect(cb).toHaveBeenLastCalledWith({ cancel: true });
  });
  it("keeps blocking when the bypass probe throws", () => {
    const cb = vi.fn();
    createRequestListener(blocker(true), () => { throw new Error("x"); })({ url: "https://a/x.js", resourceType: "script" }, cb);
    expect(cb).toHaveBeenCalledWith({ cancel: true });
  });
  it("answers an empty response when the blocker throws", () => {
    const cb = vi.fn();
    createRequestListener({ onBeforeRequest: () => { throw new Error("x"); } } as never)({ url: "https://a/", resourceType: "image" }, cb);
    expect(cb).toHaveBeenCalledWith({});
  });
});

describe("createAdBlockController", () => {
  it("registers only when enabled and an engine is loaded", () => {
    const wr = fakeWebRequest();
    const c = createAdBlockController({ partition: AD_BLOCK_PARTITION, webRequest: wr.port });
    c.setEnabled(true);
    expect(c.isActive()).toBe(false);
    expect(wr.calls).toHaveLength(0);
    c.setEngine(blocker(true));
    expect(c.isActive()).toBe(true);
    expect(wr.calls[0]![0]).toEqual({ urls: ["<all_urls>"] });
  });
  it("unregisters with null when turned off and registers again when turned on", () => {
    const wr = fakeWebRequest();
    const c = createAdBlockController({ partition: AD_BLOCK_PARTITION, webRequest: wr.port });
    c.setEngine(blocker(true));
    c.setEnabled(true);
    c.setEnabled(false);
    expect(wr.calls.at(-1)).toEqual([null]);
    expect(c.isActive()).toBe(false);
    c.setEnabled(true);
    expect(c.isActive()).toBe(true);
    expect(wr.listener).not.toBeNull();
  });
  it("does nothing for a QA partition", () => {
    const wr = fakeWebRequest();
    const c = createAdBlockController({ partition: "qa-0", webRequest: wr.port });
    c.setEngine(blocker(true));
    c.setEnabled(true);
    expect(wr.calls).toHaveLength(0);
    expect(c.isActive()).toBe(false);
  });
  it("unregisters when the engine is dropped", () => {
    const wr = fakeWebRequest();
    const c = createAdBlockController({ partition: AD_BLOCK_PARTITION, webRequest: wr.port });
    c.setEnabled(true);
    c.setEngine(blocker(true));
    c.setEngine(null);
    expect(c.isActive()).toBe(false);
  });
});

describe("loadAdBlockEngine", () => {
  it("passes a cache whose write failures are swallowed", async () => {
    const fs = { readFile: vi.fn(), writeFile: vi.fn().mockRejectedValue(new Error("disk")), mtimeMs: vi.fn().mockResolvedValue(null) };
    const engine = await loadAdBlockEngine({
      cachePath: "/c/e.bin",
      fs,
      create: async (caching) => {
        expect(caching.path).toBe("/c/e.bin");
        await expect(caching.write("/c/e.bin", new Uint8Array([1]))).resolves.toBeUndefined();
        return "engine";
      },
    });
    expect(engine).toBe("engine");
  });
  it("logs once and returns null on failure", async () => {
    const log = vi.fn();
    const engine = await loadAdBlockEngine({ cachePath: "x", fs: { readFile: vi.fn(), writeFile: vi.fn(), mtimeMs: vi.fn().mockResolvedValue(null) }, create: async () => { throw new Error("offline"); }, log });
    expect(engine).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("controller shouldBypass", () => {
  it("hands the probe to the registered listener", () => {
    const wr = fakeWebRequest();
    let bypass = false;
    const c = createAdBlockController({ partition: AD_BLOCK_PARTITION, webRequest: wr.port, shouldBypass: () => bypass });
    c.setEnabled(true);
    c.setEngine(blocker(true));
    const cb = vi.fn();
    wr.listener!({ url: "https://t/x.js", resourceType: "script" }, cb);
    expect(cb).toHaveBeenLastCalledWith({ cancel: true });
    bypass = true;
    wr.listener!({ url: "https://t/x.js", resourceType: "script" }, cb);
    expect(cb).toHaveBeenLastCalledWith({});
  });
});

describe("createFixtureBypassRegistry", () => {
  const state = (fixtureSince: number | null, releasing = false) => ({ fixtureSince, releasing });
  it("is true while any window has a fixture or a release in flight, and forgets a removed probe", () => {
    const r = createFixtureBypassRegistry({ now: () => 100 });
    expect(r.shouldBypass()).toBe(false);
    let a = state(null);
    const off = r.register(() => a);
    r.register(() => state(null));
    expect(r.shouldBypass()).toBe(false);
    a = state(100);
    expect(r.shouldBypass()).toBe(true);
    a = state(null, true);
    expect(r.shouldBypass()).toBe(true);
    off();
    expect(r.shouldBypass()).toBe(false);
  });
  it("counts a fixture for at most 15 minutes since its apply started", () => {
    let now = 1_000;
    const r = createFixtureBypassRegistry({ now: () => now });
    r.register(() => state(1_000));
    now = 1_000 + FIXTURE_BYPASS_MAX_MS - 1;
    expect(r.shouldBypass()).toBe(true);
    now = 1_000 + FIXTURE_BYPASS_MAX_MS;
    expect(r.shouldBypass()).toBe(false);
  });
  it("a release in flight counts even after the cap", () => {
    let now = 0;
    const r = createFixtureBypassRegistry({ now: () => now });
    r.register(() => state(0, true));
    now = FIXTURE_BYPASS_MAX_MS * 3;
    expect(r.shouldBypass()).toBe(true);
  });
  it("ignores a throwing probe", () => {
    const r = createFixtureBypassRegistry();
    r.register(() => { throw new Error("x"); });
    expect(r.shouldBypass()).toBe(false);
  });
});

describe("awaitSettled", () => {
  it("waits for promises, also ones added while waiting", async () => {
    const set = new Set<Promise<unknown>>();
    let resolveA!: () => void;
    const a = new Promise<void>((r) => (resolveA = r)).finally(() => set.delete(a));
    set.add(a);
    let done = false;
    const w = awaitSettled(() => set, 1000).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    let resolveB!: () => void;
    const b = new Promise<void>((r) => (resolveB = r)).finally(() => set.delete(b));
    set.add(b);
    resolveA();
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toBe(false);
    resolveB();
    await w;
    expect(done).toBe(true);
  });
  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<void>(() => {});
      let done = false;
      void awaitSettled(() => [never], 500).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(499);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("requireRestoringEnv", () => {
  it("deletes a var the load set when it was unset", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(requireRestoringEnv(env, "K", () => { env.K = "true"; return 5; })).toBe(5);
    expect("K" in env).toBe(false);
  });
  it("restores the previous value, also when the load throws", () => {
    const env: NodeJS.ProcessEnv = { K: "orig" };
    expect(() => requireRestoringEnv(env, "K", () => { env.K = "true"; throw new Error("x"); })).toThrow("x");
    expect(env.K).toBe("orig");
  });
});

describe("loadAdBlockEngine cache age", () => {
  const NOW = 1_000_000_000_000;
  const mk = (ageMs: number | null) => ({
    readFile: vi.fn().mockResolvedValue(new Uint8Array()),
    writeFile: vi.fn(),
    mtimeMs: vi.fn().mockResolvedValue(ageMs === null ? null : NOW - ageMs),
  });
  it("reads a cache younger than 7 days", async () => {
    const fs = mk(ENGINE_CACHE_MAX_AGE_MS - 1000);
    const reads: boolean[] = [];
    await loadAdBlockEngine({
      cachePath: "c", fs, now: () => NOW,
      create: async (caching) => { reads.push(await caching.read("c").then(() => true, () => false)); return "e"; },
    });
    expect(reads).toEqual([true]);
  });
  it("ignores a cache older than 7 days and builds from the network", async () => {
    const fs = mk(ENGINE_CACHE_MAX_AGE_MS + 1000);
    const reads: boolean[] = [];
    const engine = await loadAdBlockEngine({
      cachePath: "c", fs, now: () => NOW,
      create: async (caching) => { reads.push(await caching.read("c").then(() => true, () => false)); return "fresh"; },
    });
    expect(engine).toBe("fresh");
    expect(reads).toEqual([false]);
  });
  it("falls back to the old cache when the refresh fails", async () => {
    const fs = mk(ENGINE_CACHE_MAX_AGE_MS + 1000);
    const log = vi.fn();
    let n = 0;
    const engine = await loadAdBlockEngine({
      cachePath: "c", fs, now: () => NOW, log,
      create: async (caching) => {
        n++;
        if (n === 1) throw new Error("offline");
        await expect(caching.read("c")).resolves.toBeInstanceOf(Uint8Array);
        return "old";
      },
    });
    expect(engine).toBe("old");
    expect(n).toBe(2);
  });
  it("returns null when both attempts fail", async () => {
    const engine = await loadAdBlockEngine({ cachePath: "c", fs: mk(ENGINE_CACHE_MAX_AGE_MS + 1), now: () => NOW, log: vi.fn(), create: async () => { throw new Error("x"); } });
    expect(engine).toBeNull();
  });
});

describe("createEngineManager", () => {
  function setup(results: (string | null)[]) {
    let now = 0;
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const load = vi.fn(async () => results.shift() ?? null);
    const onEngine = vi.fn();
    let enabled = true;
    const m = createEngineManager<string>({
      load, onEngine, isEnabled: () => enabled, now: () => now,
      setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
    });
    return { m, load, onEngine, timers, advance: (ms: number) => { now += ms; }, setEnabled: (e: boolean) => { enabled = e; } };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("loads once and never again after success", async () => {
    const t = setup(["e"]);
    t.m.ensure(); t.m.ensure();
    await flush();
    t.m.ensure();
    expect(t.load).toHaveBeenCalledTimes(1);
    expect(t.onEngine).toHaveBeenCalledWith("e");
  });
  it("retries a failure at most once per 10 minutes, on the next ensure()", async () => {
    const t = setup([null, null, "e"]);
    t.m.ensure();
    await flush();
    t.advance(ENGINE_RETRY_MS - 1);
    t.m.ensure();
    expect(t.load).toHaveBeenCalledTimes(1);
    t.advance(1);
    t.m.ensure();
    await flush();
    expect(t.load).toHaveBeenCalledTimes(2);
    t.advance(30 * 60 * 1000); // the second failure waits 30 minutes
    t.m.ensure();
    await flush();
    expect(t.onEngine).toHaveBeenCalledWith("e");
  });
  it("retries from a timer when blocking is enabled, not when it is off", async () => {
    const t = setup([null, "e"]);
    t.m.ensure();
    await flush();
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0]!.ms).toBe(ENGINE_RETRY_MS);
    t.setEnabled(false);
    t.advance(ENGINE_RETRY_MS);
    t.timers[0]!.fn();
    await flush();
    expect(t.load).toHaveBeenCalledTimes(1);
    t.setEnabled(true);
    t.m.ensure();
    await flush();
    expect(t.load).toHaveBeenCalledTimes(2);
    expect(t.m.hasEngine()).toBe(true);
  });
  it("does nothing after dispose", async () => {
    const t = setup([null, "e"]);
    t.m.ensure();
    await flush();
    t.m.dispose();
    expect(t.timers[0]!.cancelled).toBe(true);
    t.advance(ENGINE_RETRY_MS);
    t.m.ensure();
    expect(t.load).toHaveBeenCalledTimes(1);
  });
});

describe("loadAdBlockEngine timeout", () => {
  const fsFor = (mtime: number | null) => ({ readFile: vi.fn().mockResolvedValue(new Uint8Array()), writeFile: vi.fn(), mtimeMs: vi.fn().mockResolvedValue(mtime) });
  it("cuts a hung build off after 30 s and returns null", async () => {
    vi.useFakeTimers();
    try {
      const log = vi.fn();
      let result: unknown = "pending";
      void loadAdBlockEngine({ cachePath: "c", fs: fsFor(null), log, create: () => new Promise(() => {}) }).then((r) => (result = r));
      await vi.advanceTimersByTimeAsync(ENGINE_LOAD_TIMEOUT_MS - 1);
      expect(result).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toBeNull();
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("falls back to the old cache when the refresh of a stale cache hangs", async () => {
    vi.useFakeTimers();
    try {
      const NOW = 1_000_000_000_000;
      let n = 0;
      let result: unknown = "pending";
      void loadAdBlockEngine({
        cachePath: "c", fs: fsFor(NOW - ENGINE_CACHE_MAX_AGE_MS - 1), now: () => NOW, log: vi.fn(),
        create: (caching) => {
          n++;
          return n === 1 ? new Promise(() => {}) : caching.read("c").then(() => "old");
        },
      }).then((r) => (result = r));
      await vi.advanceTimersByTimeAsync(ENGINE_LOAD_TIMEOUT_MS);
      expect(result).toBe("old");
      expect(n).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("refresh mode skips the cache, and a failure yields null without the fallback", async () => {
    const log = vi.fn();
    const reads: boolean[] = [];
    const ok = await loadAdBlockEngine({
      cachePath: "c", fs: fsFor(0), refresh: true,
      create: async (caching) => { reads.push(await caching.read("c").then(() => true, () => false)); return "fresh"; },
    });
    expect(ok).toBe("fresh");
    expect(reads).toEqual([false]);
    let n = 0;
    const failed = await loadAdBlockEngine({ cachePath: "c", fs: fsFor(0), refresh: true, log, create: async () => { n++; throw new Error("offline"); } });
    expect(failed).toBeNull();
    expect(n).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("isAdBlockCacheStale", () => {
  it("is true only for an existing file older than 7 days", async () => {
    const mk = (m: number | null | Error) => ({ readFile: vi.fn(), writeFile: vi.fn(), mtimeMs: m instanceof Error ? vi.fn().mockRejectedValue(m) : vi.fn().mockResolvedValue(m) });
    const now = () => 10 * ENGINE_CACHE_MAX_AGE_MS;
    expect(await isAdBlockCacheStale({ fs: mk(null), cachePath: "c", now })).toBe(false);
    expect(await isAdBlockCacheStale({ fs: mk(now() - ENGINE_CACHE_MAX_AGE_MS), cachePath: "c", now })).toBe(false);
    expect(await isAdBlockCacheStale({ fs: mk(now() - ENGINE_CACHE_MAX_AGE_MS - 1), cachePath: "c", now })).toBe(true);
    expect(await isAdBlockCacheStale({ fs: mk(new Error("x")), cachePath: "c", now })).toBe(false);
  });
});

describe("createEngineManager backoff, logging and refresh", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  function setup(opts: { loads?: (string | null)[]; refreshes?: (string | null)[]; stale?: () => boolean } = {}) {
    let now = 0;
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const loads = opts.loads ?? [];
    const refreshes = opts.refreshes ?? [];
    const lines: string[] = [];
    const load = vi.fn(async (report: (m: string, e: unknown) => void) => {
      const r = loads.shift() ?? null;
      if (r === null) report("[adblock] engine load failed", new Error("offline"));
      return r;
    });
    const refresh = vi.fn(async (report: (m: string, e: unknown) => void) => {
      const r = refreshes.shift() ?? null;
      if (r === null) report("[adblock] refresh failed", new Error("offline"));
      return r;
    });
    const onEngine = vi.fn();
    let enabled = true;
    const m = createEngineManager<string>({
      load, refresh, isStale: async () => (opts.stale ?? (() => true))(), onEngine, isEnabled: () => enabled, now: () => now, log: (l) => lines.push(l),
      setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
    });
    const pending = () => timers.filter((t) => !t.cancelled);
    return { m, load, refresh, onEngine, timers, pending, lines, advance: (ms: number) => { now += ms; }, setEnabled: (e: boolean) => { enabled = e; } };
  }
  const MIN = 60 * 1000;

  it("backs off 10 min, 30 min, then 60 min", async () => {
    const t = setup({ loads: [null, null, null, null] });
    t.m.ensure();
    await flush();
    expect(t.timers.map((x) => x.ms)).toEqual([10 * MIN]);
    t.advance(10 * MIN);
    t.pending()[0]!.fn();
    await flush();
    expect(t.timers.map((x) => x.ms)).toEqual([10 * MIN, 30 * MIN]);
    // not before 30 min
    t.advance(30 * MIN - 1);
    t.m.ensure();
    expect(t.load).toHaveBeenCalledTimes(2);
    t.advance(1);
    t.m.ensure();
    await flush();
    expect(t.timers.map((x) => x.ms)).toEqual([10 * MIN, 30 * MIN, 60 * MIN]);
    t.advance(60 * MIN);
    t.m.ensure();
    await flush();
    expect(t.timers.map((x) => x.ms)).toEqual([10 * MIN, 30 * MIN, 60 * MIN, 60 * MIN]);
    expect(t.load).toHaveBeenCalledTimes(4);
  });

  it("logs only the first failure of a streak, and again after a success", async () => {
    const t = setup({ loads: [null, null, "e"] });
    t.m.ensure();
    await flush();
    t.advance(10 * MIN);
    t.m.ensure();
    await flush();
    t.advance(30 * MIN);
    t.m.ensure();
    await flush();
    expect(t.load).toHaveBeenCalledTimes(3);
    expect(t.lines).toEqual(["[adblock] engine load failed: offline"]);
  });

  it("logs a thrown load once and keeps the manager usable", async () => {
    const lines: string[] = [];
    let calls = 0;
    const m = createEngineManager<string>({
      load: async () => { calls++; throw new Error("boom"); }, onEngine: vi.fn(), isEnabled: () => true, log: (l) => lines.push(l), setTimer: () => () => {},
    });
    m.ensure();
    await flush();
    expect(calls).toBe(1);
    expect(lines).toHaveLength(1);
  });

  it("a hung-then-timed-out load (null) frees the loading flag so a retry can run", async () => {
    const t = setup({ loads: [null, "e"] });
    t.m.ensure();
    await flush();
    t.advance(10 * MIN);
    t.m.ensure();
    await flush();
    expect(t.m.hasEngine()).toBe(true);
  });

  it("checks the engine age every 24 h and swaps in a refreshed engine", async () => {
    const t = setup({ loads: ["old"], refreshes: ["new"] });
    t.m.ensure();
    await flush();
    const check = t.pending().find((x) => x.ms === ENGINE_REFRESH_CHECK_MS)!;
    expect(check).toBeDefined();
    check.fn();
    await flush();
    expect(t.refresh).toHaveBeenCalledTimes(1);
    expect(t.onEngine).toHaveBeenLastCalledWith("new");
    // the fired check was re-armed
    expect(t.timers.filter((x) => x.ms === ENGINE_REFRESH_CHECK_MS)).toHaveLength(2);
  });

  it("keeps the old engine and logs the failure once when a refresh fails", async () => {
    const t = setup({ loads: ["old"], refreshes: [null, null] });
    t.m.ensure();
    await flush();
    for (let i = 0; i < 2; i++) {
      t.pending().find((x) => x.ms === ENGINE_REFRESH_CHECK_MS)!.fn();
      await flush();
    }
    expect(t.refresh).toHaveBeenCalledTimes(2);
    expect(t.onEngine).toHaveBeenCalledTimes(1);
    expect(t.onEngine).toHaveBeenCalledWith("old");
    expect(t.lines).toEqual(["[adblock] refresh failed: offline"]);
    expect(t.m.hasEngine()).toBe(true);
  });

  it("does not refresh a young engine or while blocking is off", async () => {
    const young = setup({ loads: ["e"], stale: () => false });
    young.m.ensure();
    await flush();
    young.pending().find((x) => x.ms === ENGINE_REFRESH_CHECK_MS)!.fn();
    await flush();
    expect(young.refresh).not.toHaveBeenCalled();

    const off = setup({ loads: ["e"] });
    off.m.ensure();
    await flush();
    off.setEnabled(false);
    off.pending().find((x) => x.ms === ENGINE_REFRESH_CHECK_MS)!.fn();
    await flush();
    expect(off.refresh).not.toHaveBeenCalled();
  });

  it("dispose cancels the refresh check", async () => {
    const t = setup({ loads: ["e"] });
    t.m.ensure();
    await flush();
    t.m.dispose();
    expect(t.pending()).toHaveLength(0);
  });
});
