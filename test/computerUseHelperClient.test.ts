import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerUseHelper, HelperError, type ChildLike } from "../src/main/computerUse/helperClient";
import { ERR_NATIVE_UNSUPPORTED, NATIVE_MODE_NOTE } from "../src/main/computerUse/errors";

function fakeChild() {
  const out: ((c: Buffer | string) => void)[] = [];
  const err: ((c: Buffer | string) => void)[] = [];
  const exit: ((code: number | null) => void)[] = [];
  const childErr: ((e: Error) => void)[] = [];
  const spawned: (() => void)[] = [];
  const stdinErr: ((e: Error) => void)[] = [];
  const written: string[] = [];
  const child: ChildLike = {
    stdin: { write: (d: string) => void written.push(d), on: (_e, cb) => void stdinErr.push(cb) },
    stdout: { on: (_e, cb) => void out.push(cb) },
    stderr: { on: (_e, cb) => void err.push(cb) },
    on: ((e: string, cb: unknown) => {
      if (e === "error") childErr.push(cb as (x: Error) => void);
      else if (e === "spawn") spawned.push(cb as () => void);
      else exit.push(cb as (c: number | null) => void);
    }) as ChildLike["on"],
    kill: vi.fn(),
  };
  return {
    child,
    written,
    send: (s: string) => out.forEach((cb) => cb(Buffer.from(s))),
    log: (s: string) => err.forEach((cb) => cb(s)),
    spawned: () => spawned.forEach((cb) => cb()),
    spawnError: (m: string) => childErr.forEach((cb) => cb(new Error(m))),
    stdinError: (m: string) => stdinErr.forEach((cb) => cb(new Error(m))),
    die: (code: number | null = 1) => exit.forEach((cb) => cb(code)),
    req: (i: number) => JSON.parse(written[i]) as Record<string, unknown>,
  };
}

function setup(timeouts?: Record<string, number>) {
  const kids: ReturnType<typeof fakeChild>[] = [];
  const spawn = vi.fn(() => {
    const k = fakeChild();
    kids.push(k);
    return k.child;
  });
  const logs: string[] = [];
  const helper = new ComputerUseHelper({ binPath: "/bin/h", spawn, timeouts, onLog: (l) => logs.push(l) });
  return { helper, kids, spawn, logs };
}

afterEach(() => vi.useRealTimers());

describe("ComputerUseHelper", () => {
  it("spawns lazily, writes one JSON line with numeric ids and resolves without id/ok", async () => {
    const { helper, kids, spawn } = setup();
    expect(spawn).not.toHaveBeenCalled();
    const p = helper.call("windows", { pid: 7 });
    expect(spawn).toHaveBeenCalledWith("/bin/h");
    const k = kids[0];
    expect(k.written[0].endsWith("\n")).toBe(true);
    expect(k.req(0)).toEqual({ id: 1, cmd: "windows", pid: 7 });
    k.send('{"id":1,"ok":true,"windows":[]}\n');
    await expect(p).resolves.toEqual({ windows: [] });
    const p2 = helper.call("ping");
    expect(k.req(1).id).toBe(2);
    k.send('{"id":2,"ok":true,"version":1}\n');
    await expect(p2).resolves.toEqual({ version: 1 });
  });

  it("frames partial chunks and several lines per chunk, out of order", async () => {
    const { helper, kids } = setup();
    const a = helper.call("ping");
    const b = helper.call("ping");
    const k = kids[0];
    k.send('{"id":2,"ok":tr');
    k.send('ue,"n":2}\n{"id":1,"ok":true,"n":1}\n{"id');
    await expect(b).resolves.toEqual({ n: 2 });
    await expect(a).resolves.toEqual({ n: 1 });
  });

  it("rejects with HelperError carrying the helper code", async () => {
    const { helper, kids } = setup();
    const p = helper.call("perform");
    kids[0].send('{"id":1,"ok":false,"error":"gone","code":"STALE"}\n');
    const e = await p.catch((x) => x);
    expect(e).toBeInstanceOf(HelperError);
    expect(e.message).toBe("gone");
    expect(e.code).toBe("STALE");
  });

  it("uses helper budget + 1 s: 6 s snapshot/read/screenshot/perform, 11 s type, 3 s others, and overrides", async () => {
    vi.useFakeTimers();
    const { helper } = setup({ read: 100 });
    const snap = helper.call("snapshot").catch((e) => e);
    const click = helper.call("click").catch((e) => e);
    const read = helper.call("read").catch((e) => e);
    expect(helper.timeoutFor("perform")).toBe(6000);
    expect(helper.timeoutFor("screenshot")).toBe(6000);
    expect(helper.timeoutFor("type")).toBe(11000);
    expect(helper.timeoutFor("watch")).toBe(3000);
    const custom = helper.call("ping", {}, { timeoutMs: 50 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(50);
    expect((await custom).code).toBe("TIMEOUT");
    await vi.advanceTimersByTimeAsync(50);
    expect((await read).code).toBe("TIMEOUT");
    await vi.advanceTimersByTimeAsync(2900);
    expect((await click).code).toBe("TIMEOUT");
    let snapDone = false;
    void snap.then(() => (snapDone = true));
    await vi.advanceTimersByTimeAsync(2900);
    expect(snapDone).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect((await snap).code).toBe("TIMEOUT");
  });

  it("ignores a late answer after a timeout", async () => {
    vi.useFakeTimers();
    const { helper, kids } = setup();
    const p = helper.call("ping").catch((e) => e);
    await vi.advanceTimersByTimeAsync(3000);
    expect((await p).code).toBe("TIMEOUT");
    expect(() => kids[0].send('{"id":1,"ok":true}\n')).not.toThrow();
  });

  it("rejects pending calls and notifies when the helper dies, then respawns on the next call", async () => {
    const { helper, kids, spawn } = setup();
    const onExit = vi.fn();
    helper.onExit(onExit);
    const p = helper.call("ping");
    kids[0].die(9);
    const e = await p.catch((x) => x);
    expect(e.code).toBe("HELPER_EXIT");
    expect(onExit).toHaveBeenCalledWith(9);
    expect(helper.alive).toBe(false);
    const p2 = helper.call("ping");
    expect(spawn).toHaveBeenCalledTimes(2);
    kids[1].send('{"id":2,"ok":true}\n');
    await expect(p2).resolves.toEqual({});
  });

  it("delivers unsolicited events and stderr lines", () => {
    const { helper, kids, logs } = setup();
    const got: unknown[] = [];
    const off = helper.onEvent((e) => got.push(e));
    void helper.call("ping").catch(() => {});
    kids[0].send('{"event":"appTerminated","pid":42}\n');
    kids[0].log("hello\nworld\n");
    expect(got).toEqual([{ event: "appTerminated", pid: 42 }]);
    expect(logs).toEqual(["hello", "world"]);
    off();
    kids[0].send('{"event":"appTerminated","pid":43}\n');
    expect(got).toHaveLength(1);
  });

  it("close rejects pending and later calls, and kills the child without onExit", async () => {
    const { helper, kids } = setup();
    const onExit = vi.fn();
    helper.onExit(onExit);
    const p = helper.call("ping");
    helper.close();
    expect((await p.catch((e) => e)).code).toBe("HELPER_CLOSED");
    expect(kids[0].child.kill).toHaveBeenCalled();
    expect((await helper.call("ping").catch((e) => e)).code).toBe("HELPER_CLOSED");
    kids[0].die(0);
    expect(onExit).not.toHaveBeenCalled();
  });

  it("turns a spawn failure into a rejected HELPER_SPAWN", async () => {
    const helper = new ComputerUseHelper({
      binPath: "/x",
      spawn: () => {
        throw new Error("ENOENT");
      },
    });
    expect((await helper.call("ping").catch((e) => e)).code).toBe("HELPER_SPAWN");
  });

  it("a child 'error' event rejects pending calls with HELPER_SPAWN, resets the child and never throws", async () => {
    const { helper, kids, spawn } = setup();
    const onExit = vi.fn();
    helper.onExit(onExit);
    const p = helper.call("ping");
    expect(() => kids[0].spawnError("spawn ENOENT")).not.toThrow();
    const e = await p.catch((x) => x);
    expect(e.code).toBe("HELPER_SPAWN");
    expect(e.message).toContain("ENOENT");
    expect(helper.alive).toBe(false);
    expect(onExit).toHaveBeenCalledTimes(1);
    kids[0].die(1); // a late exit of the dead child changes nothing
    expect(onExit).toHaveBeenCalledTimes(1);
    const p2 = helper.call("ping");
    expect(spawn).toHaveBeenCalledTimes(2);
    kids[1].send('{"id":2,"ok":true}\n');
    await expect(p2).resolves.toEqual({});
  });

  it("a child 'error' after the 'spawn' event is HELPER_EXIT, not HELPER_SPAWN", async () => {
    const { helper, kids } = setup();
    const p = helper.call("ping");
    kids[0].spawned();
    kids[0].spawnError("write failed");
    const e = await p.catch((x) => x);
    expect(e.code).toBe("HELPER_EXIT");
    expect(helper.alive).toBe(false);
  });

  it("a child 'error' after the first stdout data is HELPER_EXIT", async () => {
    const { helper, kids } = setup();
    const p1 = helper.call("ping");
    kids[0].send('{"id":1,"ok":true}\n');
    await p1;
    const p2 = helper.call("ping");
    kids[0].spawnError("boom");
    expect((await p2.catch((x) => x)).code).toBe("HELPER_EXIT");
  });

  it("an EPIPE on stdin rejects pending calls with HELPER_EXIT and resets the child", async () => {
    const { helper, kids } = setup();
    const p = helper.call("ping");
    expect(() => kids[0].stdinError("write EPIPE")).not.toThrow();
    expect((await p.catch((x) => x)).code).toBe("HELPER_EXIT");
    expect(helper.alive).toBe(false);
  });

  it("ignores garbage lines", async () => {
    const { helper, kids, logs } = setup();
    const p = helper.call("ping");
    kids[0].send('not json\n[1]\n{"id":1,"ok":true}\n');
    await expect(p).resolves.toEqual({});
    expect(logs).toHaveLength(1);
  });
});

describe("errors", () => {
  it("names the unsupported action", () => {
    expect(ERR_NATIVE_UNSUPPORTED("reload")).toContain("reload");
    expect(NATIVE_MODE_NOTE).toContain("without a restart");
  });
});
