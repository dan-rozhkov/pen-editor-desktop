import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserSessions,
  ERR_INVALID_SESSION_ID,
  ERR_LOGINS_UNAVAILABLE,
  ERR_NO_SUCH_SESSION,
  DRAIN_TIMEOUT_MS,
  ERR_SESSION_CLOSED,
  ERR_SESSION_CREATE_FAILED,
  ERR_SESSION_NOT_OWNED,
  ERR_TOO_MANY_SESSIONS,
  PARTITION_POOL_SIZE,
  PartitionPool,
  ScopeCounter,
  SlotUnusableError,
  TOMBSTONE_LIMIT,
  commandMayCreateSession,
  parseSessionId,
  planSessionCommand,
} from "../src/main/browserSessions";
import { ERR_NO_JOURNAL } from "../src/main/journalOwners";

describe("parseSessionId", () => {
  it("a payload without a session key is the shared browser", () => {
    expect(parseSessionId({ command: "open" })).toEqual({ ok: true, id: undefined });
  });

  it.each(["a", "run_1-X", "A".repeat(64)])("accepts %s", (id) => {
    expect(parseSessionId({ session: id })).toEqual({ ok: true, id });
  });

  it.each([
    ["empty", ""],
    ["too long", "a".repeat(65)],
    ["space", "a b"],
    ["slash", "../x"],
    ["dot", "a.b"],
    ["colon", "persist:x"],
    ["number", 5],
    ["null", null],
    ["undefined value", undefined],
    ["object", {}],
  ])("rejects %s (never falls back to the shared browser)", (_name, value) => {
    expect(parseSessionId({ session: value })).toEqual({ ok: false, error: ERR_INVALID_SESSION_ID });
  });
});

describe("commandMayCreateSession", () => {
  it("only page-creating commands may create", () => {
    expect(commandMayCreateSession("open", {})).toBe(true);
    expect(commandMayCreateSession("applyFixture", {})).toBe(true);
    expect(commandMayCreateSession("startJournal", undefined)).toBe(true);
    expect(commandMayCreateSession("tabs", { action: "new" })).toBe(true);
    for (const [c, a] of [
      ["tabs", { action: "list" }],
      ["tabs", { action: "switch" }],
      ["tabs", undefined],
      ["snapshot", undefined],
      ["act", {}],
      ["read", {}],
      ["screenshot", {}],
      ["fillLogin", {}],
      ["releaseFixture", {}],
      ["nope", {}],
    ] as const) {
      expect(commandMayCreateSession(c, a), `${c} ${JSON.stringify(a)}`).toBe(false);
    }
  });
});

describe("planSessionCommand", () => {
  it("an unknown command never runs or creates, in any state", () => {
    for (const state of ["live", "missing", "closed", "foreign"] as const) {
      expect(planSessionCommand("bogus", {}, state)).toEqual({ action: "reply", value: { error: "Unknown browser command: bogus" } });
    }
  });

  it("a foreign session answers the ownership error", () => {
    expect(planSessionCommand("open", {}, "foreign")).toEqual({ action: "reply", value: { error: ERR_SESSION_NOT_OWNED } });
  });

  it("a missing session: creating commands create, the rest get a fixed error", () => {
    expect(planSessionCommand("open", {}, "missing")).toEqual({ action: "run", create: true });
    expect(planSessionCommand("tabs", { action: "new" }, "missing")).toEqual({ action: "run", create: true });
    expect(planSessionCommand("snapshot", undefined, "missing")).toEqual({ action: "reply", value: { error: ERR_NO_SUCH_SESSION } });
    expect(planSessionCommand("tabs", { action: "list" }, "missing")).toEqual({ action: "reply", value: { error: ERR_NO_SUCH_SESSION } });
    expect(planSessionCommand("fillLogin", {}, "missing")).toEqual({ action: "reply", value: { error: ERR_NO_SUCH_SESSION } });
  });

  it("cleanup commands answer naturally for a missing or closed session", () => {
    for (const state of ["missing", "closed"] as const) {
      expect(planSessionCommand("releaseFixture", {}, state)).toEqual({ action: "reply", value: { ok: true } });
      expect(planSessionCommand("stopJournal", {}, state)).toEqual({ action: "reply", value: false });
      expect(planSessionCommand("captureCheckpoint", {}, state)).toEqual({ action: "reply", value: { ok: false, error: ERR_NO_JOURNAL } });
    }
  });

  it("a closed session refuses everything else, even creating commands", () => {
    for (const c of ["open", "applyFixture", "startJournal", "snapshot", "tabs"]) {
      expect(planSessionCommand(c, { action: "new" }, "closed")).toEqual({ action: "reply", value: { error: ERR_SESSION_CLOSED } });
    }
  });

  it("a live session runs its commands, without creating; fillLogin is refused", () => {
    expect(planSessionCommand("open", {}, "live")).toEqual({ action: "run", create: false });
    expect(planSessionCommand("releaseFixture", {}, "live")).toEqual({ action: "run", create: false });
    expect(planSessionCommand("fillLogin", {}, "live")).toEqual({ action: "reply", value: { ok: false, error: ERR_LOGINS_UNAVAILABLE } });
  });
});

describe("PartitionPool", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hands out qa-0..qa-5 and no more", async () => {
    const pool = new PartitionPool();
    const slots: (string | null)[] = [];
    for (let i = 0; i < PARTITION_POOL_SIZE; i++) slots.push(await pool.acquire());
    expect(slots).toEqual(["qa-0", "qa-1", "qa-2", "qa-3", "qa-4", "qa-5"]);
  });

  it("a waiter gets the next released slot, FIFO", async () => {
    const pool = new PartitionPool(1);
    const first = await pool.acquire();
    const w1 = pool.acquire();
    const w2 = pool.acquire();
    pool.release(first!);
    expect(await w1).toBe("qa-0");
    pool.release("qa-0");
    expect(await w2).toBe("qa-0");
  });

  it("gives up after the wait and does not hand a later slot to the timed-out waiter", async () => {
    const pool = new PartitionPool(1, 1000);
    await pool.acquire();
    const w = pool.acquire();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await w).toBeNull();
    pool.release("qa-0");
    expect(await pool.acquire()).toBe("qa-0");
  });

  it("a slot counts as prepared only after markPrepared", () => {
    const pool = new PartitionPool();
    expect(pool.isPrepared("qa-1")).toBe(false);
    expect(pool.isPrepared("qa-1")).toBe(false); // checking does not mark
    pool.markPrepared("qa-1");
    expect(pool.isPrepared("qa-1")).toBe(true);
    expect(pool.isPrepared("qa-2")).toBe(false);
  });

  it("a cancelled ticket leaves the queue: it resolves null and does not take the next slot", async () => {
    const pool = new PartitionPool(1, 1_000_000);
    await pool.acquire();
    const t = pool.ticket();
    const next = pool.acquire();
    t.cancel();
    expect(await t.promise).toBeNull();
    pool.release("qa-0");
    expect(await next).toBe("qa-0");
  });
});

describe("BrowserSessions", () => {
  const make = (size = 2, waitMs = 1000) => {
    const pool = new PartitionPool(size, waitMs);
    return { pool, reg: new BrowserSessions<{ p: string }>(pool) };
  };
  const create = (p: string) => ({ p });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("creates lazily on a slot, reuses it for the same owner", async () => {
    const { reg } = make();
    const first = await reg.acquire("a", 7, true, create);
    const again = await reg.acquire("a", 7, false, create);
    expect(first).toMatchObject({ ok: true, session: { partition: "qa-0", ctx: { p: "qa-0" } } });
    expect(again).toMatchObject({ ok: true, session: { partition: "qa-0" } });
    expect(reg.size).toBe(1);
  });

  it("a missing session is not created without allowCreate", async () => {
    const { reg } = make();
    expect(await reg.acquire("a", 7, false, create)).toEqual({ ok: false, error: ERR_NO_SUCH_SESSION });
    expect(reg.size).toBe(0);
  });

  it("refuses another editor tab", async () => {
    const { reg } = make();
    await reg.acquire("a", 7, true, create);
    expect(await reg.acquire("a", 8, true, create)).toEqual({ ok: false, error: ERR_SESSION_NOT_OWNED });
    expect(reg.stateOf("a", 8)).toBe("foreign");
    expect(reg.stateOf("a", 7)).toBe("live");
    expect(reg.stateOf("zzz", 7)).toBe("missing");
  });

  it("two simultaneous first commands share one session", async () => {
    const { reg } = make();
    const make1 = vi.fn(create);
    const [x, y] = await Promise.all([reg.acquire("a", 1, true, make1), reg.acquire("a", 1, true, make1)]);
    expect(x.ok && y.ok).toBe(true);
    expect(make1).toHaveBeenCalledTimes(1);
  });

  it("waits for a free slot (app-wide pool) and errors after the wait", async () => {
    const { reg } = make(1, 1000);
    await reg.acquire("a", 1, true, create);
    const waiting = reg.acquire("b", 1, true, create);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await waiting).toEqual({ ok: false, error: ERR_TOO_MANY_SESSIONS });
    expect(reg.size).toBe(1);
  });

  it("a waiter gets the slot of a session that finishes closing, with the cleaned partition", async () => {
    const { reg } = make(1);
    const a = await reg.acquire("a", 1, true, create);
    const waiting = reg.acquire("b", 1, true, create);
    const s = reg.beginClose("a", 1)!;
    reg.finishClose(s);
    expect(await waiting).toMatchObject({ ok: true, session: { id: "b", partition: "qa-0" } });
    expect(a.ok).toBe(true);
  });

  it("a session can be shared across registries through one pool (app-wide cap)", async () => {
    const pool = new PartitionPool(1, 500);
    const r1 = new BrowserSessions<null>(pool);
    const r2 = new BrowserSessions<null>(pool);
    await r1.acquire("a", 1, true, () => null);
    const waiting = r2.acquire("b", 1, true, () => null);
    await vi.advanceTimersByTimeAsync(500);
    expect(await waiting).toEqual({ ok: false, error: ERR_TOO_MANY_SESSIONS });
  });

  describe("tombstones", () => {
    it("a closed id can never be recreated or entered", async () => {
      const { reg, pool } = make();
      await reg.acquire("a", 1, true, create);
      const s = reg.beginClose("a", 1)!;
      reg.finishClose(s);
      expect(reg.stateOf("a", 1)).toBe("closed");
      expect(await reg.acquire("a", 1, true, create)).toEqual({ ok: false, error: ERR_SESSION_CLOSED });
      const slots = [await pool.acquire(), await pool.acquire()]; // both slots free again, none leaked
      expect(slots.sort()).toEqual(["qa-0", "qa-1"]);
    });

    it("closing an id that never existed tombstones it too", async () => {
      const { reg } = make();
      expect(reg.beginClose("x", 1)).toBeUndefined();
      expect(await reg.acquire("x", 1, true, create)).toEqual({ ok: false, error: ERR_SESSION_CLOSED });
    });

    it("a close that races a creation waiting for a slot wins and returns the slot", async () => {
      const { reg, pool } = make(1);
      await pool.acquire(); // pool empty
      const waiting = reg.acquire("a", 1, true, create);
      reg.beginClose("a", 1);
      pool.release("qa-0");
      expect(await waiting).toEqual({ ok: false, error: ERR_SESSION_CLOSED });
      expect(await pool.acquire()).toBe("qa-0");
    });

    it("cancelling a creation takes its waiter out of the pool queue: the next waiter gets the slot", async () => {
      const { reg, pool } = make(1);
      await pool.acquire();
      const a = reg.acquire("a", 1, true, create);
      const b = reg.acquire("b", 1, true, create);
      reg.beginClose("a", 1);
      expect(await a).toEqual({ ok: false, error: ERR_SESSION_CLOSED });
      pool.release("qa-0");
      expect(await b).toMatchObject({ ok: true, session: { id: "b", partition: "qa-0" } });
    });

    it("tombstones belong to the owner tab and go when it is destroyed", () => {
      const { reg } = make();
      reg.beginClose("mine", 1);
      reg.beginClose("other", 2);
      reg.forgetOwner(1);
      expect(reg.stateOf("mine", 1)).toBe("missing");
      expect(reg.stateOf("other", 2)).toBe("closed");
    });

    it("a creation cancelled by a close stays closed even after the owner's tombstones are dropped", async () => {
      const { reg, pool } = make(1);
      await pool.acquire();
      const waiting = reg.acquire("a", 1, true, create);
      reg.beginClose("a", 1);
      reg.forgetOwner(1);
      pool.release("qa-0");
      expect(await waiting).toEqual({ ok: false, error: ERR_SESSION_CLOSED });
      expect(reg.size).toBe(0);
    });

    it("is bounded: the oldest ids are forgotten", () => {
      const { reg } = make();
      for (let i = 0; i <= TOMBSTONE_LIMIT; i++) reg.beginClose(`id${i}`, 1);
      expect(reg.stateOf("id0", 1)).toBe("missing");
      expect(reg.stateOf(`id${TOMBSTONE_LIMIT}`, 1)).toBe("closed");
    });
  });

  describe("in-flight commands", () => {
    it("waitDrained waits for every started command to exit", async () => {
      const { reg } = make();
      const a = await reg.acquire("a", 1, true, create);
      const b = await reg.acquire("a", 1, false, create);
      if (!a.ok || !b.ok) throw new Error("setup");
      const s = reg.beginClose("a", 1)!;
      let drained = false;
      void reg.waitDrained(s).then((ok) => (drained = ok));
      a.exit();
      await Promise.resolve();
      expect(drained).toBe(false);
      b.exit();
      b.exit(); // idempotent
      await Promise.resolve();
      expect(drained).toBe(true);
    });

    it("a closing session takes no new command, and is not live", async () => {
      const { reg } = make();
      await reg.acquire("a", 1, true, create);
      expect(reg.isLive("a")).toBe(true);
      reg.beginClose("a", 1);
      expect(reg.isLive("a")).toBe(false);
      expect(await reg.acquire("a", 1, true, create)).toEqual({ ok: false, error: ERR_SESSION_CLOSED });
    });

    it("waitDrained gives up after the timeout", async () => {
      const { reg } = make();
      const a = await reg.acquire("a", 1, true, create);
      if (!a.ok) throw new Error("setup");
      const s = reg.beginClose("a", 1)!;
      let drained = false;
      let result: boolean | null = null;
      void reg.waitDrained(s, 500).then((ok) => (result = ok));
      await vi.advanceTimersByTimeAsync(500);
      expect(result).toBe(false);
      expect(drained).toBe(false);
    });
  });

  describe("pending creation", () => {
    it("is seen as existing: a follow-up command waits for it and then acts on the session", async () => {
      const { reg, pool } = make(1);
      await pool.acquire();
      const creator = reg.acquire("a", 1, true, create);
      expect(reg.stateOf("a", 1)).toBe("pending");
      expect(reg.stateOf("a", 2)).toBe("foreign");
      expect(planSessionCommand("releaseFixture", {}, "pending")).toEqual({ action: "run", create: false });
      expect(planSessionCommand("snapshot", {}, "pending")).toEqual({ action: "run", create: false });
      const follower = reg.acquire("a", 1, false, create);
      pool.release("qa-0");
      const [c, f] = await Promise.all([creator, follower]);
      expect(c.ok && f.ok).toBe(true);
      if (c.ok && f.ok) expect(c.session).toBe(f.session);
    });
  });

  describe("create failures", () => {
    it("a throwing create returns a structured error to the creator and every waiter, frees the slot, leaves nothing pending", async () => {
      const onError = vi.fn();
      const pool = new PartitionPool(1, 1000);
      const reg = new BrowserSessions<null>(pool, undefined, onError);
      const boom = () => {
        throw new Error("boom");
      };
      const a = reg.acquire("a", 1, true, boom);
      const b = reg.acquire("a", 1, false, boom);
      expect(await a).toEqual({ ok: false, error: ERR_SESSION_CREATE_FAILED });
      expect(await b).toEqual({ ok: false, error: ERR_SESSION_CREATE_FAILED });
      expect(onError).toHaveBeenCalled();
      expect(reg.stateOf("a", 1)).toBe("missing");
      expect(reg.size).toBe(0);
      expect(await pool.acquire()).toBe("qa-0");
    });
  });

  describe("close()", () => {
    const hooks = (teardown: () => Promise<boolean> = async () => true, abort: () => void = () => {}) => ({ abort, teardown });

    it("returns the slot after a clean teardown, only once in-flight commands exit", async () => {
      const { reg, pool } = make(1);
      const a = await reg.acquire("a", 1, true, create);
      if (!a.ok) throw new Error("setup");
      const teardown = vi.fn(async () => true);
      const abort = vi.fn();
      const closing = reg.close("a", 1, hooks(teardown, abort));
      await Promise.resolve();
      expect(teardown).not.toHaveBeenCalled();
      a.exit();
      await closing;
      expect(teardown).toHaveBeenCalledTimes(1);
      expect(abort).not.toHaveBeenCalled();
      expect(await pool.acquire()).toBe("qa-0");
    });

    it("a second close of a closing session returns the same promise", async () => {
      const { reg } = make(1);
      const a = await reg.acquire("a", 1, true, create);
      if (!a.ok) throw new Error("setup");
      const first = reg.close("a", 1, hooks());
      const second = reg.close("a", 1, hooks());
      expect(second).toBe(first);
      a.exit();
      await first;
    });

    it("drain timeout: abort runs first (closing the tabs unblocks the command), then teardown, then the slot returns", async () => {
      const { reg, pool } = make(1, 1_000_000);
      const a = await reg.acquire("a", 1, true, create);
      if (!a.ok) throw new Error("setup");
      const order: string[] = [];
      const closing = reg.close(
        "a",
        1,
        hooks(
          async () => (order.push("teardown"), true),
          () => {
            order.push("abort");
            a.exit(); // the stuck command settles once its tabs are gone
          },
        ),
      );
      await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS);
      await closing;
      expect(order).toEqual(["abort", "teardown"]);
      expect(await pool.acquire()).toBe("qa-0");
    });

    it("still stuck after the second wait: the slot is quarantined and the session dropped", async () => {
      const onError = vi.fn();
      const pool = new PartitionPool(1, 1_000_000);
      const reg = new BrowserSessions<{ p: string }>(pool, undefined, onError);
      const a = await reg.acquire("a", 1, true, create);
      if (!a.ok) throw new Error("setup");
      const teardown = vi.fn(async () => true);
      const closing = reg.close("a", 1, hooks(teardown));
      await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS * 2);
      await closing;
      expect(teardown).not.toHaveBeenCalled();
      expect(reg.size).toBe(0);
      expect(reg.peek("a")).toBeUndefined();
      let got: string | null | undefined;
      void pool.acquire().then((x) => (got = x));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(got).toBeUndefined(); // still waiting: the slot never came back
      expect(onError).toHaveBeenCalledWith("quarantined partition", "qa-0: commands still in flight");
    });

    it("a failed wipe quarantines the slot but frees the session", async () => {
      const onError = vi.fn();
      const pool = new PartitionPool(1, 100);
      const reg = new BrowserSessions<{ p: string }>(pool, undefined, onError);
      const a = await reg.acquire("a", 1, true, create);
      if (a.ok) a.exit();
      await reg.close("a", 1, hooks(async () => false));
      expect(reg.size).toBe(0);
      const next = pool.acquire();
      await vi.advanceTimersByTimeAsync(100);
      expect(await next).toBeNull();
      expect(onError).toHaveBeenCalledWith("quarantined partition", "qa-0: wipe failed");
    });

    it("a throwing teardown also quarantines", async () => {
      const pool = new PartitionPool(1, 100);
      const reg = new BrowserSessions<{ p: string }>(pool);
      const a = await reg.acquire("a", 1, true, create);
      if (a.ok) a.exit();
      await reg.close(
        "a",
        1,
        hooks(async () => {
          throw new Error("x");
        }),
      );
      const next = pool.acquire();
      await vi.advanceTimersByTimeAsync(100);
      expect(await next).toBeNull();
    });
  });

  describe("ownership of a close", () => {
    it("a non-owner closes nothing and tombstones nothing", async () => {
      const { reg } = make();
      await reg.acquire("a", 1, true, create);
      expect(reg.beginClose("a", 2)).toBeUndefined();
      expect(reg.stateOf("a", 1)).toBe("live");
      expect(reg.stateOf("a", 2)).toBe("foreign");
    });

    it("closing a never-created id tombstones it for the caller only", async () => {
      const { reg } = make();
      reg.beginClose("x", 1);
      expect(reg.stateOf("x", 1)).toBe("closed");
      expect(reg.stateOf("x", 2)).toBe("missing");
      expect((await reg.acquire("x", 2, true, create)).ok).toBe(true);
    });
  });

  describe("unusable slot", () => {
    it("a create that throws SlotUnusableError keeps the slot out of the pool", async () => {
      const onError = vi.fn();
      const pool = new PartitionPool(1, 100);
      const reg = new BrowserSessions<null>(pool, undefined, onError);
      const r = await reg.acquire("a", 1, true, () => {
        throw new SlotUnusableError("no deny-all");
      });
      expect(r).toEqual({ ok: false, error: ERR_SESSION_CREATE_FAILED });
      const next = pool.acquire();
      await vi.advanceTimersByTimeAsync(100);
      expect(await next).toBeNull();
    });
  });

  it("idsOwnedBy finds live and being-created sessions of one editor tab", async () => {
    const { reg } = make(2);
    await reg.acquire("a", 1, true, create);
    await reg.acquire("b", 2, true, create);
    void reg.acquire("c", 1, true, create); // waits for a slot
    await Promise.resolve();
    expect(reg.idsOwnedBy(1).sort()).toEqual(["a", "c"]);
    expect(reg.idsOwnedBy(2)).toEqual(["b"]);
    expect(reg.idsOwnedBy(3)).toEqual([]);
    reg.beginClose("a", 1);
    expect(reg.idsOwnedBy(1)).toEqual(["c"]);
  });

  it("ownerOf covers existing and pending sessions", async () => {
    const { reg } = make(1);
    await reg.acquire("a", 5, true, create);
    void reg.acquire("b", 6, true, create);
    await Promise.resolve();
    expect(reg.ownerOf("a")).toBe(5);
    expect(reg.ownerOf("b")).toBe(6);
    expect(reg.ownerOf("c")).toBeUndefined();
  });
});

describe("ScopeCounter", () => {
  it("counts per scope: a session command does not mark the shared scope", () => {
    const c = new ScopeCounter();
    c.inc("a");
    expect(c.active("a")).toBe(true);
    expect(c.active(undefined)).toBe(false);
    expect(c.active("b")).toBe(false);
    c.inc(undefined);
    c.inc("a");
    c.dec("a");
    expect(c.active("a")).toBe(true);
    c.dec("a");
    expect(c.active("a")).toBe(false);
    expect(c.active(undefined)).toBe(true);
    c.dec(undefined);
    c.dec(undefined); // extra dec is harmless
    expect(c.active(undefined)).toBe(false);
  });

  it("a session id equal to the empty scope key cannot collide", () => {
    const c = new ScopeCounter();
    c.inc("x");
    expect(c.active(undefined)).toBe(false);
  });
});
