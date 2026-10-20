import { describe, expect, it, vi } from "vitest";
import {
  APP_CONFIRM_BUTTONS,
  APP_RESTART_BUTTONS,
  USER_PROFILE_NOTE,
  appRestartDetail,
  appRestartMessage,
  errAppDidNotQuit,
  ERR_APP_BAD_ROOT,
  ERR_APP_BUSY,
  ERR_APP_DENIED,
  ERR_APP_GONE,
  ERR_APP_PENDING,
  ERR_APP_RELEASED,
  ERR_APP_QUIT_ON_LAUNCH,
  errorForPlan,
  openApp,
  routeAppCommand,
  shapeLaunchResult,
  type AppController,
  ERR_APP_CAP,
  ERR_APP_NOT_BUNDLE,
  ERR_APP_NOT_ELECTRON,
  ERR_APP_NOT_FOUND,
  ERR_APP_OWN_BUNDLE,
  appKey,
  bundleOf,
  createAppConfirm,
  createAppRegistry,
  filterUserPids,
  intersectWorkspacePids,
  parseWorkspacePids,
  workspacePidsArgs,
  WORKSPACE_PIDS_JXA,
  ERR_APP_PROFILE_BUSY,
  killHandleSync,
  QUIT_REOPEN_SCRIPT,
  ranAtRelease,
  quitReopenShellArgs,
  ownedBySender,
  ownedBySession,
  planAppCommand,
  validateAppPath,
  type AppPathDeps,
} from "../src/main/appTargets";

const ELECTRON_FW = "Contents/Frameworks/Electron Framework.framework";

function pathDeps(over: { links?: Record<string, string>; dirs?: string[]; env?: Record<string, string>; packaged?: boolean; exe?: string } = {}): AppPathDeps {
  const links = over.links ?? {};
  const dirs = new Set(over.dirs ?? []);
  const exists = (p: string) => p in links || [...dirs].some((d) => d === p || d.startsWith(p + "/")) || ["/Applications", "/Users/me/Applications"].includes(p);
  return {
    realpath: async (p) => {
      if (!exists(p)) throw new Error("ENOENT");
      return links[p] ?? p;
    },
    isDirectory: async (p) => dirs.has(p),
    homeDir: "/Users/me",
    ownExecutable: over.exe ?? "/Applications/Sideform Desktop.app/Contents/MacOS/Sideform Desktop",
    isPackaged: over.packaged ?? true,
    env: over.env ?? {},
  };
}

describe("validateAppPath", () => {
  const orca = "/Applications/Orca.app";
  const ok = { dirs: [`${orca}/${ELECTRON_FW}`] };

  it("accepts an Electron bundle under /Applications", async () => {
    expect(await validateAppPath(orca, pathDeps(ok))).toEqual({ ok: true, realPath: orca, name: "Orca" });
  });
  it("accepts ~/Applications", async () => {
    const p = "/Users/me/Applications/Foo.app";
    expect(await validateAppPath(p, pathDeps({ dirs: [`${p}/${ELECTRON_FW}`] }))).toMatchObject({ ok: true, name: "Foo" });
  });
  it("rejects non-strings, relative paths and missing paths", async () => {
    expect(await validateAppPath(42, pathDeps())).toEqual({ ok: false, error: ERR_APP_NOT_BUNDLE });
    expect(await validateAppPath("Orca.app", pathDeps())).toEqual({ ok: false, error: ERR_APP_NOT_BUNDLE });
    expect(await validateAppPath("/Applications/Nope.app", pathDeps())).toEqual({ ok: false, error: ERR_APP_NOT_FOUND });
  });
  it("rejects a path that is not a .app", async () => {
    expect(await validateAppPath("/Applications", pathDeps())).toEqual({ ok: false, error: ERR_APP_NOT_BUNDLE });
  });
  it("rejects a bundle outside the roots", async () => {
    const p = "/opt/Evil.app";
    expect(await validateAppPath(p, pathDeps({ dirs: [`${p}/${ELECTRON_FW}`] }))).toEqual({ ok: false, error: ERR_APP_BAD_ROOT });
  });
  it("checks the real path: a symlink in /Applications pointing outside is refused", async () => {
    const link = "/Applications/Evil.app";
    const target = "/tmp/Evil.app";
    const r = await validateAppPath(link, pathDeps({ links: { [link]: target }, dirs: [`${target}/${ELECTRON_FW}`] }));
    expect(r).toEqual({ ok: false, error: ERR_APP_BAD_ROOT });
  });
  it("refuses a bundle without Electron Framework", async () => {
    expect(await validateAppPath("/Applications/Safari.app", pathDeps({ dirs: ["/Applications/Safari.app/Contents"] }))).toEqual({
      ok: false,
      error: ERR_APP_NOT_ELECTRON,
    });
  });
  it("refuses our own bundle, also through a symlink", async () => {
    const own = "/Applications/Sideform Desktop.app";
    expect(await validateAppPath(own, pathDeps({ dirs: [`${own}/${ELECTRON_FW}`] }))).toEqual({ ok: false, error: ERR_APP_OWN_BUNDLE });
    const alias = "/Applications/Alias.app";
    expect(await validateAppPath(alias, pathDeps({ links: { [alias]: own }, dirs: [`${own}/${ELECTRON_FW}`] }))).toEqual({
      ok: false,
      error: ERR_APP_OWN_BUNDLE,
    });
  });
  it("extra roots work only when unpackaged", async () => {
    const p = "/fixtures/Fix.app";
    const base = { dirs: [`${p}/${ELECTRON_FW}`], env: { PEN_DESKTOP_APP_ROOTS: "/fixtures" }, links: { "/fixtures": "/fixtures" } };
    expect(await validateAppPath(p, pathDeps({ ...base, packaged: false }))).toMatchObject({ ok: true });
    expect(await validateAppPath(p, pathDeps({ ...base, packaged: true }))).toEqual({ ok: false, error: ERR_APP_BAD_ROOT });
  });
});

describe("bundleOf", () => {
  it("finds the enclosing bundle", () => {
    expect(bundleOf("/Applications/X.app/Contents/MacOS/X")).toBe("/Applications/X.app");
    expect(bundleOf("/usr/bin/node")).toBeNull();
  });
});

describe("createAppConfirm", () => {
  const app = { name: "Orca", realPath: "/Applications/Orca.app" };
  const make = (...answers: number[]) => {
    const queue = [...answers];
    const showMessageBox = vi.fn(async (_w: unknown, _o: unknown) => ({ response: queue.shift() ?? 2 }));
    return { showMessageBox, c: createAppConfirm({ showMessageBox }) };
  };

  it("shows name, full path, the user-rights warning and the three buttons, defaulting to deny", async () => {
    const { c, showMessageBox } = make(2);
    await c.confirm("win", app, 1);
    const opts = showMessageBox.mock.calls[0][1] as { message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number };
    expect(opts.message).toContain("Orca");
    expect(opts.detail).toContain("/Applications/Orca.app");
    expect(opts.detail).toMatch(/your user rights/);
    expect(opts.detail).toMatch(/keychain/);
    expect(opts.buttons).toEqual([...APP_CONFIRM_BUTTONS]);
    expect(opts.defaultId).toBe(2);
    expect(opts.cancelId).toBe(2);
  });
  it("allow once asks again next time", async () => {
    const { c, showMessageBox } = make(0, 0);
    expect(await c.confirm("w", app, 1)).toBe(true);
    expect(await c.confirm("w", app, 1)).toBe(true);
    expect(showMessageBox).toHaveBeenCalledTimes(2);
  });
  it("allow until quit is remembered per path and per owner only", async () => {
    const { c, showMessageBox } = make(1, 2, 2);
    expect(await c.confirm("w", app, 1)).toBe(true);
    expect(await c.confirm("w", app, 1)).toBe(true);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(await c.confirm("w", { name: "Other", realPath: "/Applications/Other.app" }, 1)).toBe(false);
    expect(await c.confirm("w", app, 2)).toBe(false); // another sender asks again
    expect(showMessageBox).toHaveBeenCalledTimes(3);
  });
  it("restart confirm: own text and buttons, deny by default, ignores and never adds to the remembered answer", async () => {
    const showMessageBox = vi.fn(async (_w: unknown, _o: unknown) => ({ response: 0 }));
    const c = createAppConfirm({ showMessageBox });
    expect(await c.confirm("w", app, 1)).toBe(true); // Allow once: nothing remembered
    expect(await c.confirmRestart("w", app)).toBe(true);
    const opts = showMessageBox.mock.calls[1][1] as { message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number };
    expect(opts.message).toBe(appRestartMessage("Orca"));
    expect(opts.detail).toBe(appRestartDetail("/Applications/Orca.app"));
    expect(opts.buttons).toEqual([...APP_RESTART_BUTTONS]);
    expect(opts.defaultId).toBe(1);
    expect(opts.cancelId).toBe(1);
    await c.confirm("w", app, 1);
    expect(showMessageBox).toHaveBeenCalledTimes(3); // restart did not remember
    const remembering = createAppConfirm({ showMessageBox: vi.fn(async () => ({ response: 1 })) });
    await remembering.confirm("w", app, 1);
    expect(await remembering.confirmRestart("w", app)).toBe(false); // remembered allow does not skip it
  });
  it("deny is not remembered", async () => {
    const { c, showMessageBox } = make(2, 0);
    expect(await c.confirm("w", app, 1)).toBe(false);
    expect(await c.confirm("w", app, 1)).toBe(true);
    expect(showMessageBox).toHaveBeenCalledTimes(2);
  });
});

function fakeHandle() {
  let disconnect: () => void = () => {};
  const controller = {
    tabs: vi.fn(async () => ({ tabs: [{ tabId: 1, url: "file:///x/index.html", title: "X", current: true }], current: 1 })),
  };
  const h = {
    controller,
    close: vi.fn(async () => {}),
    onDisconnected: (cb: () => void) => {
      disconnect = cb;
    },
    drop: () => disconnect(),
  };
  return h;
}
type Fake = ReturnType<typeof fakeHandle>;

describe("createAppRegistry", () => {
  const registry = (launch?: (p: string) => Promise<Fake>) => {
    const made: Fake[] = [];
    const impl = launch ?? (async () => fakeHandle());
    const reg = createAppRegistry<Fake>({
      launch: async (p) => {
        const h = await impl(p);
        made.push(h);
        return h;
      },
    });
    const open = async (key: string, p = "/A") => {
      const b = reg.begin(key);
      if (!b.ok) return b;
      return b.ticket.launch(p);
    };
    return { made, reg, open };
  };

  it("launches and exposes the handle by key", async () => {
    const { reg, open } = registry();
    expect((await open("1:")).ok).toBe(true);
    expect(reg.state("1:")).toBe("running");
    expect(reg.get("1:")).toBeDefined();
    expect(reg.state("2:")).toBe("none");
  });
  it("reserves the key at begin: a parallel open gets BUSY", async () => {
    const { reg, open } = registry();
    const b = reg.begin("1:");
    expect(b.ok).toBe(true);
    expect(reg.state("1:")).toBe("pending");
    expect(await open("1:")).toEqual({ ok: false, error: ERR_APP_BUSY });
    if (b.ok) b.ticket.abort();
    expect(reg.state("1:")).toBe("none");
  });
  it("caps running plus pending at 2", async () => {
    const { reg, open } = registry();
    await open("1:");
    const pend = reg.begin("2:");
    expect(pend.ok).toBe(true);
    expect(await open("3:")).toEqual({ ok: false, error: ERR_APP_CAP });
  });
  it("relaunch starts the new app first and closes the old one only after success", async () => {
    let finish: (h: Fake) => void = () => {};
    let first = true;
    const { reg, made } = registry(() => (first ? ((first = false), Promise.resolve(fakeHandle())) : new Promise<Fake>((r) => (finish = r))));
    const b1 = reg.begin("1:");
    if (b1.ok) await b1.ticket.launch("/A");
    const b2 = reg.begin("1:");
    expect(b2.ok).toBe(true);
    const second = b2.ok ? b2.ticket.launch("/B") : Promise.reject();
    await Promise.resolve();
    expect(made[0].close).not.toHaveBeenCalled();
    finish(fakeHandle());
    expect((await second).ok).toBe(true);
    expect(made[0].close).toHaveBeenCalled();
    expect(reg.get("1:")).toBe(made[1]);
  });
  it("a failed relaunch keeps the old app", async () => {
    let fail = false;
    const { reg, made } = registry(async () => {
      if (fail) throw new Error("no debug port");
      return fakeHandle();
    });
    const b1 = reg.begin("1:");
    if (b1.ok) await b1.ticket.launch("/A");
    fail = true;
    const b2 = reg.begin("1:");
    const r = b2.ok ? await b2.ticket.launch("/B") : null;
    expect(r).toEqual({ ok: false, error: "no debug port" });
    expect(made[0].close).not.toHaveBeenCalled();
    expect(reg.state("1:")).toBe("running");
  });
  it("keeps a sticky tombstone when the app quits; release clears it", async () => {
    const { reg, made, open } = registry();
    await open("1:");
    made[0].drop();
    expect(reg.state("1:")).toBe("gone");
    expect(reg.get("1:")).toBeUndefined();
    expect(made[0].close).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(reg.size()).toBe(0); // a quit app frees the cap once closed
    await reg.release("1:");
    expect(reg.state("1:")).toBe("none");
  });
  it("reports a launch failure and frees the key", async () => {
    let fail = true;
    const { reg, open } = registry(async () => {
      if (fail) throw new Error("no debug port");
      return fakeHandle();
    });
    expect(await open("1:")).toEqual({ ok: false, error: "no debug port" });
    expect(reg.state("1:")).toBe("none");
    fail = false;
    expect((await open("1:")).ok).toBe(true);
  });
  it("release during launch cancels: result discarded, app closed, key stays BUSY until the flight finishes, reported as pending", async () => {
    let finish: (h: Fake) => void = () => {};
    const { reg, made } = registry(() => new Promise<Fake>((r) => (finish = r)));
    const b = reg.begin("1:");
    const launched = b.ok ? b.ticket.launch("/A") : Promise.reject();
    expect(await reg.release("1:")).toEqual({ pending: true });
    expect(await reg.release("1:")).toEqual({ pending: false });
    expect(reg.begin("1:")).toEqual({ ok: false, error: ERR_APP_BUSY });
    expect(reg.size()).toBe(1); // still spawning: counts toward the cap
    finish(fakeHandle());
    expect(await launched).toEqual({ ok: false, error: ERR_APP_RELEASED });
    expect(made[0].close).toHaveBeenCalled();
    expect(reg.state("1:")).toBe("none");
    expect(reg.size()).toBe(0);
  });
  it("release while only validating/confirming cancels the ticket", async () => {
    const { reg } = registry();
    const b = reg.begin("1:");
    await reg.releaseWhere(ownedBySender(1));
    expect(b.ok && b.ticket.cancelled).toBe(true);
    if (b.ok) expect(await b.ticket.launch("/A")).toEqual({ ok: false, error: ERR_APP_RELEASED });
  });
  it("releaseWhere closes only matching keys; releaseAll closes everything and cancels pending", async () => {
    const { reg, made, open } = registry();
    await open(appKey(7, undefined));
    await open(appKey(8, "s1"));
    await reg.releaseWhere(ownedBySender(7));
    expect(made[0].close).toHaveBeenCalled();
    expect(made[1].close).not.toHaveBeenCalled();
    const p = reg.begin("9:");
    await reg.releaseAll();
    expect(made[1].close).toHaveBeenCalled();
    expect(p.ok && p.ticket.cancelled).toBe(true);
    if (p.ok) p.ticket.abort();
    expect(reg.size()).toBe(0);
  });
  it("a failing close does not break release", async () => {
    const h = fakeHandle();
    h.close.mockRejectedValueOnce(new Error("boom"));
    const { reg, open } = registry(async () => h);
    await open("1:");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(reg.release("1:")).resolves.toEqual({ pending: false });
  });
});

describe("createAppRegistry: races and quit", () => {
  const make = (extra: { killSync?: (h: Fake) => void; isAlive?: (h: Fake) => boolean; reopenDetached?: (p: string) => void } = {}) => {
    const made: Fake[] = [];
    const reg = createAppRegistry<Fake>({ launch: async () => { const h = fakeHandle(); made.push(h); return h; }, ...extra });
    return { reg, made };
  };

  it("a release during the old app's close cancels the relaunch: never ok, the new app is closed", async () => {
    const { reg, made } = make();
    const b1 = reg.begin("1:");
    if (b1.ok) await b1.ticket.launch("/A");
    let finishOld: () => void = () => {};
    made[0].close.mockImplementationOnce(() => new Promise<void>((r) => (finishOld = r)));
    const b2 = reg.begin("1:");
    const second = b2.ok ? b2.ticket.launch("/B") : Promise.reject();
    await new Promise((r) => setTimeout(r, 0));
    const rel = reg.release("1:");
    finishOld();
    await rel;
    expect(await second).toEqual({ ok: false, error: ERR_APP_RELEASED });
    expect(made[1].close).toHaveBeenCalled();
    expect(reg.state("1:")).toBe("none");
  });
  it("a relaunch does not count the key's own app against the cap; other keys do", async () => {
    const { reg } = make();
    for (const k of ["1:", "2:"]) {
      const b = reg.begin(k);
      if (b.ok) await b.ticket.launch("/A");
    }
    const again = reg.begin("1:");
    expect(again.ok).toBe(true);
    if (again.ok) again.ticket.abort();
    expect(reg.begin("3:")).toEqual({ ok: false, error: ERR_APP_CAP });
  });
  it("open, release, open loops cannot exceed the cap while spawns are still closing", async () => {
    const resolvers: ((h: Fake) => void)[] = [];
    const reg = createAppRegistry<Fake>({ launch: () => new Promise<Fake>((r) => resolvers.push(r)) });
    const tickets = [];
    for (const k of ["1:", "2:"]) {
      const b = reg.begin(k);
      if (b.ok) tickets.push(b.ticket.launch("/A"));
      await reg.release(k);
    }
    expect(reg.begin("3:")).toEqual({ ok: false, error: ERR_APP_CAP });
    for (const r of resolvers) r(fakeHandle());
    await Promise.all(tickets);
    expect(reg.begin("3:").ok).toBe(true);
  });
  it("an app that quit before binding is a tombstone and an error, not ok", async () => {
    const { reg } = make({ isAlive: () => false });
    const b = reg.begin("1:");
    expect(b.ok && (await b.ticket.launch("/A"))).toEqual({ ok: false, error: ERR_APP_QUIT_ON_LAUNCH });
    expect(reg.state("1:")).toBe("gone");
  });
  it("killAllSync kills every spawned app synchronously, including ones already closing", async () => {
    const killSync = vi.fn();
    const { reg, made } = make({ killSync });
    for (const k of ["1:", "2:"]) {
      const b = reg.begin(k);
      if (b.ok) await b.ticket.launch("/A");
    }
    made[0].close.mockImplementationOnce(() => new Promise<void>(() => {})); // stuck close
    void reg.release("1:");
    reg.killAllSync();
    expect(killSync).toHaveBeenCalledTimes(2);
    expect(reg.state("2:")).toBe("none");
  });
  it("killAllSync reopens a flight marked user-app-quit that is not live, once", () => {
    const reopenDetached = vi.fn();
    const { reg } = make({ reopenDetached });
    const b = reg.begin("1:");
    const plain = reg.begin("2:");
    if (b.ok) b.ticket.markUserAppQuit("/Applications/O.app");
    reg.killAllSync();
    reg.killAllSync();
    expect(reopenDetached).toHaveBeenCalledTimes(1);
    expect(reopenDetached).toHaveBeenCalledWith("/Applications/O.app");
    expect(plain.ok && plain.ticket.cancelled).toBe(true);
  });
  it("killAllSync does not reopen a marked flight whose handle is live (killSync owns it)", async () => {
    const reopenDetached = vi.fn();
    const killSync = vi.fn();
    const { reg } = make({ reopenDetached, killSync });
    const b = reg.begin("1:");
    if (b.ok) {
      b.ticket.markUserAppQuit("/A");
      await b.ticket.launch("/A");
    }
    reg.killAllSync();
    expect(reopenDetached).not.toHaveBeenCalled();
    expect(killSync).toHaveBeenCalledTimes(1);
  });
  it("killAllSync cancels pending flights", async () => {
    const { reg } = make();
    const b = reg.begin("1:");
    reg.killAllSync();
    expect(b.ok && b.ticket.cancelled).toBe(true);
  });
});

describe("confirm memory per owner", () => {
  it("forgetSender voids that owner's remembered answers only", async () => {
    const showMessageBox = vi.fn(async () => ({ response: 1 }));
    const c = createAppConfirm({ showMessageBox });
    const app = { name: "O", realPath: "/Applications/O.app" };
    await c.confirm("w", app, 1);
    await c.confirm("w", app, 2);
    c.forgetSender(1);
    await c.confirm("w", app, 2);
    expect(showMessageBox).toHaveBeenCalledTimes(2);
    await c.confirm("w", app, 1);
    expect(showMessageBox).toHaveBeenCalledTimes(3);
  });
});

describe("key predicates", () => {
  it("separate senders and sessions", () => {
    expect(appKey(3, undefined)).toBe("3:");
    expect(appKey(3, "run")).toBe("3:run");
    expect(ownedBySender(3)("3:run")).toBe(true);
    expect(ownedBySender(3)("33:")).toBe(false);
    expect(ownedBySession(3, "run")("3:run")).toBe(true);
    expect(ownedBySession(3, "run")("3:")).toBe(false);
  });
});

describe("planAppCommand", () => {
  it("launches on open with a non-empty app, whatever the state", () => {
    for (const s of ["none", "pending", "running", "gone"] as const) expect(planAppCommand("open", { app: "/Applications/Orca.app" }, s)).toBe("launch");
  });
  it("refuses a malformed app instead of falling back to the browser", () => {
    expect(planAppCommand("open", { app: "" }, "none")).toBe("refuse");
    expect(planAppCommand("open", { app: 5, url: "https://x.y" }, "none")).toBe("refuse");
  });
  it("passes everything through without a binding", () => {
    for (const c of ["open", "act", "snapshot", "capture", "applyFixture", "tabs"]) expect(planAppCommand(c, { url: "https://x.y" }, "none")).toBe("passthrough");
  });
  it("routes page commands to a running app", () => {
    for (const c of ["open", "act", "snapshot", "read", "screenshot", "tabs", "findImages", "perform", "assert"]) {
      expect(planAppCommand(c, {}, "running")).toBe("route");
    }
  });
  it("a quit app stays bound: routed commands answer gone, never the built-in browser", () => {
    for (const c of ["open", "act", "snapshot", "read", "screenshot", "tabs", "findImages", "perform", "assert"]) {
      expect(planAppCommand(c, { url: "https://x.y" }, "gone")).toBe("gone");
    }
  });
  it("commands during a pending launch answer pending", () => {
    for (const c of ["act", "snapshot", "open"]) expect(planAppCommand(c, { url: "https://x.y" }, "pending")).toBe("pending");
  });
  it("refuses built-in-browser-only commands while bound", () => {
    for (const s of ["running", "gone", "pending"] as const) {
      for (const c of ["capture", "applyFixture", "fillLogin", "startJournal", "captureCheckpoint"]) expect(planAppCommand(c, {}, s)).toBe("refuse");
    }
  });
  it("lets cleanup commands through and releaseApp always releases", () => {
    for (const c of ["releaseFixture", "clearActEmulation", "stopJournal"]) expect(planAppCommand(c, {}, "running")).toBe("passthrough");
    for (const s of ["none", "pending", "running", "gone"] as const) expect(planAppCommand("releaseApp", undefined, s)).toBe("release");
  });
  it("error replies", () => {
    expect(errorForPlan("gone", "act", {})).toEqual({ error: ERR_APP_GONE });
    expect(errorForPlan("pending", "act", {})).toEqual({ error: ERR_APP_PENDING });
    expect(errorForPlan("refuse", "capture", {}).error).toMatch(/built-in browser/);
  });
});

describe("routing table and launch result", () => {
  const fakeController = (): AppController & Record<string, ReturnType<typeof vi.fn>> => {
    const names = ["open", "act", "findImages", "snapshot", "perform", "assert", "read", "screenshot", "tabs"];
    return Object.fromEntries(names.map((n) => [n, vi.fn(async () => ({ via: n }))])) as never;
  };
  it("sends each command to the controller method of the same name with its args", async () => {
    const c = fakeController();
    for (const n of ["open", "act", "findImages", "perform", "assert", "read", "screenshot", "tabs"]) {
      expect(await routeAppCommand(c, n, { a: 1 })).toEqual({ via: n });
      expect(c[n]).toHaveBeenCalledWith({ a: 1 });
    }
    expect(await routeAppCommand(c, "snapshot", undefined)).toEqual({ via: "snapshot" });
  });
  it("unknown or inherited names are an error, not a call", async () => {
    const c = fakeController();
    expect(await routeAppCommand(c, "capture", {})).toHaveProperty("error");
    expect(await routeAppCommand(c, "constructor", {})).toHaveProperty("error");
    expect(await routeAppCommand(c, "toString", {})).toHaveProperty("error");
  });
  it("shapes a tabs listing like an open result", () => {
    expect(shapeLaunchResult({ tabs: [{ url: "a", title: "A" }, { url: "b", title: "B", current: true }], current: 2 }, "Orca")).toMatchObject({
      url: "b",
      title: "B",
      app: "Orca",
    });
    expect(shapeLaunchResult(undefined, "Orca")).toEqual({ url: "", title: "", app: "Orca" });
  });
});

describe("openApp", () => {
  const valid = { ok: true as const, realPath: "/Applications/Orca.app", name: "Orca" };
  const setup = (over: {
    validate?: () => Promise<never | typeof valid | { ok: false; error: string }>;
    confirm?: () => Promise<boolean>;
    running?: number[];
    confirmRestart?: () => Promise<boolean>;
    quit?: (pid: number) => Promise<boolean>;
    launch?: () => Promise<Fake>;
  } = {}) => {
    const handles: Fake[] = [];
    const launch = vi.fn(async (p: string, o?: { userProfile?: boolean }) => {
      const h = Object.assign(over.launch ? await over.launch() : fakeHandle(), { appPath: p, userProfile: o?.userProfile === true });
      handles.push(h);
      return h;
    });
    const reg = createAppRegistry<Fake>({ launch });
    const confirm = vi.fn(over.confirm ?? (async () => true));
    const confirmRestart = vi.fn(over.confirmRestart ?? (async () => true));
    const validate = vi.fn(over.validate ?? (async () => valid));
    const findRunning = vi.fn(async (_p: string) => over.running ?? []);
    const quit = vi.fn(over.quit ?? (async () => true));
    const reopen = vi.fn(async (_p: string) => {});
    const cancelWaiters = vi.fn((_p: string) => {});
    return {
      reg, handles, confirm, confirmRestart, validate, findRunning, quit, reopen, launch,
      cancelWaiters,
      run: (key = "1:") => openApp(key, "/Applications/Orca.app", { registry: reg, validate, confirm, findRunning, confirmRestart, quit, reopen, cancelWaiters }),
    };
  };

  it("validates, confirms, launches and shapes the result", async () => {
    const { run, reg } = setup();
    expect(await run()).toMatchObject({ url: "file:///x/index.html", title: "X", app: "Orca" });
    expect(reg.state("1:")).toBe("running");
  });
  it("a refused path or a denial never launches and frees the key", async () => {
    const bad = setup({ validate: async () => ({ ok: false, error: ERR_APP_BAD_ROOT }) });
    expect(await bad.run()).toEqual({ error: ERR_APP_BAD_ROOT });
    expect(bad.reg.state("1:")).toBe("none");
    const denied = setup({ confirm: async () => false });
    expect(await denied.run()).toEqual({ error: ERR_APP_DENIED });
    expect(denied.handles).toHaveLength(0);
    expect(denied.reg.state("1:")).toBe("none");
  });
  it("holds the key while the dialog is open: a second open is BUSY and commands are pending", async () => {
    let answer: (v: boolean) => void = () => {};
    const { run, reg } = setup({ confirm: () => new Promise<boolean>((r) => (answer = r)) });
    const first = run();
    await new Promise((r) => setTimeout(r, 0));
    expect(reg.state("1:")).toBe("pending");
    expect(await run()).toEqual({ error: ERR_APP_BUSY });
    answer(true);
    expect(await first).toHaveProperty("app", "Orca");
  });
  it("a release while the dialog is open means no launch after Allow", async () => {
    let answer: (v: boolean) => void = () => {};
    const { run, reg, handles } = setup({ confirm: () => new Promise<boolean>((r) => (answer = r)) });
    const first = run();
    await new Promise((r) => setTimeout(r, 0));
    expect(await reg.release("1:")).toEqual({ pending: true });
    answer(true);
    expect(await first).toEqual({ error: ERR_APP_RELEASED });
    expect(handles).toHaveLength(0);
  });
  it("a release while validating means the dialog is never shown", async () => {
    let done: (v: typeof valid) => void = () => {};
    const { run, reg, confirm } = setup({ validate: () => new Promise((r) => (done = r as never)) });
    const first = run();
    await new Promise((r) => setTimeout(r, 0));
    await reg.release("1:");
    done(valid);
    expect(await first).toEqual({ error: ERR_APP_RELEASED });
    expect(confirm).not.toHaveBeenCalled();
  });
  it("a cancelled open still showing its dialog keeps the key BUSY", async () => {
    let answer: (v: boolean) => void = () => {};
    const { run, reg } = setup({ confirm: () => new Promise<boolean>((r) => (answer = r)) });
    const first = run();
    await new Promise((r) => setTimeout(r, 0));
    await reg.release("1:");
    expect(await run()).toEqual({ error: ERR_APP_BUSY });
    answer(true);
    await first;
    expect(reg.state("1:")).toBe("none");
  });
  it("never throws", async () => {
    const { run, reg } = setup({ validate: async () => { throw new Error("boom"); } });
    expect(await run()).toEqual({ error: "boom" });
    expect(reg.state("1:")).toBe("none");
  });

  describe("the app is already open", () => {
    it("not running: the normal path, temp profile, no restart confirm", async () => {
      const t = setup();
      const res = await t.run();
      expect(res).not.toHaveProperty("profile");
      expect(t.confirm).toHaveBeenCalledTimes(1);
      expect(t.confirmRestart).not.toHaveBeenCalled();
      expect(t.quit).not.toHaveBeenCalled();
      expect(t.launch.mock.calls[0][1]).toBeUndefined();
    });
    it("running: asks the restart confirm (not the normal one), quits every pid, launches with the user profile", async () => {
      const t = setup({ running: [11, 12] });
      const res = await t.run();
      expect(t.confirmRestart).toHaveBeenCalledTimes(1);
      expect(t.confirm).not.toHaveBeenCalled();
      expect(t.quit.mock.calls.map((c) => c[0])).toEqual([11, 12]);
      expect(t.launch.mock.calls[0][1]).toEqual({ userProfile: true });
      expect(res).toMatchObject({ app: "Orca", profile: "user", note: USER_PROFILE_NOTE });
      expect(t.reopen).not.toHaveBeenCalled();
    });
    it("shows the restart confirm even when the normal one was remembered", async () => {
      const showMessageBox = vi.fn(async (_w: unknown, _o: unknown) => ({ response: 1 }));
      const c = createAppConfirm({ showMessageBox });
      const app = { name: "Orca", realPath: "/Applications/Orca.app" };
      await c.confirm("w", app, 1); // remembered
      const t = setup({ running: [11] });
      const res = await openApp("1:", "x", {
        registry: t.reg, validate: t.validate, findRunning: t.findRunning, quit: t.quit, reopen: t.reopen,
        confirm: () => c.confirm("w", app, 1),
        confirmRestart: () => c.confirmRestart("w", app),
      });
      expect(showMessageBox).toHaveBeenCalledTimes(2);
      expect(res).toEqual({ error: ERR_APP_DENIED });
      expect(t.quit).not.toHaveBeenCalled();
    });
    it("denied: nothing is quit or launched", async () => {
      const t = setup({ running: [11], confirmRestart: async () => false });
      expect(await t.run()).toEqual({ error: ERR_APP_DENIED });
      expect(t.quit).not.toHaveBeenCalled();
      expect(t.launch).not.toHaveBeenCalled();
      expect(t.reopen).not.toHaveBeenCalled();
      expect(t.reg.state("1:")).toBe("none");
    });
    it("a pid that does not quit: error, no launch, nothing to reopen", async () => {
      const t = setup({ running: [11], quit: async () => false });
      expect(await t.run()).toEqual({ error: errAppDidNotQuit("Orca") });
      expect(t.launch).not.toHaveBeenCalled();
      expect(t.reopen).not.toHaveBeenCalled();
      expect(t.reg.state("1:")).toBe("none");
    });
    it("a release during the quit: reopens the app and answers released", async () => {
      let quitDone: (v: boolean) => void = () => {};
      const t = setup({ running: [11], quit: () => new Promise<boolean>((r) => (quitDone = r)) });
      const first = t.run();
      await new Promise((r) => setTimeout(r, 0));
      await t.reg.release("1:");
      quitDone(true);
      expect(await first).toEqual({ error: ERR_APP_RELEASED });
      expect(t.reopen).toHaveBeenCalledWith("/Applications/Orca.app");
      expect(t.launch).not.toHaveBeenCalled();
    });
    it("the first successful quit marks the flight, so a Sideform quit in the gap reopens the app", async () => {
      const reopenDetached = vi.fn();
      let release!: (h: Fake) => void;
      const reg = createAppRegistry<Fake>({ launch: () => new Promise<Fake>((r) => { release = r; }), reopenDetached });
      const t = setup({ running: [11] });
      const p = openApp("1:", "/Applications/Orca.app", {
        registry: reg, validate: t.validate, confirm: t.confirm, confirmRestart: t.confirmRestart,
        findRunning: t.findRunning, quit: t.quit, reopen: t.reopen,
      });
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      reg.killAllSync();
      expect(reopenDetached).toHaveBeenCalledWith("/Applications/Orca.app");
      release(fakeHandle());
      await p;
    });
    it("a launch failure after the quit reopens the app and returns the error", async () => {
      const t = setup({ running: [11], launch: async () => { throw new Error("no start"); } });
      expect(await t.run()).toEqual({ error: "no start" });
      expect(t.reopen).toHaveBeenCalledWith("/Applications/Orca.app");
    });
    it("marks the flight BEFORE the quit: a Sideform quit during a pending quit spawns the helper with that pid", async () => {
      const quitReopenDetached = vi.fn();
      const reopenDetached = vi.fn();
      const reg = createAppRegistry<Fake>({ launch: async () => fakeHandle(), quitReopenDetached, reopenDetached });
      let quitDone: (v: boolean) => void = () => {};
      const t = setup({ running: [11], quit: () => new Promise<boolean>((r) => (quitDone = r)) });
      const p = openApp("1:", "/Applications/Orca.app", {
        registry: reg, validate: t.validate, confirm: t.confirm, confirmRestart: t.confirmRestart,
        findRunning: t.findRunning, quit: t.quit, reopen: t.reopen,
      });
      await vi.waitFor(() => expect(t.quit).toHaveBeenCalledWith(11));
      reg.killAllSync(); // the terminate may be in flight: the quit has NOT returned
      expect(quitReopenDetached).toHaveBeenCalledTimes(1);
      expect(quitReopenDetached).toHaveBeenCalledWith("/Applications/Orca.app", 11);
      expect(reopenDetached).not.toHaveBeenCalled();
      quitDone(true);
      await p;
    });
    it("a quit that times out spawns reopenWhenGone(realPath, pid) and errors", async () => {
      const t = setup({ running: [11], quit: async () => false });
      const reopenWhenGone = vi.fn();
      const res = await openApp("1:", "x", {
        registry: t.reg, validate: t.validate, confirm: t.confirm, confirmRestart: t.confirmRestart,
        findRunning: t.findRunning, quit: t.quit, reopen: t.reopen, reopenWhenGone,
      });
      expect(res).toEqual({ error: errAppDidNotQuit("Orca") });
      expect(reopenWhenGone).toHaveBeenCalledWith("/Applications/Orca.app", 11);
      expect(t.launch).not.toHaveBeenCalled();
    });
    it("re-reads the running pids after the restart confirm and quits the fresh ones", async () => {
      const t = setup({ running: [11] });
      t.findRunning.mockResolvedValueOnce([11]).mockResolvedValueOnce([22, 23]);
      const res = await t.run();
      expect(t.findRunning).toHaveBeenCalledTimes(2);
      expect(t.quit.mock.calls.map((c) => c[0])).toEqual([22, 23]);
      expect(res).toMatchObject({ profile: "user" });
    });
    it("the app closed during the restart dialog: still launches with the user profile", async () => {
      const t = setup({ running: [11] });
      t.findRunning.mockResolvedValueOnce([11]).mockResolvedValueOnce([]);
      const res = await t.run();
      expect(t.quit).not.toHaveBeenCalled();
      expect(t.launch.mock.calls[0][1]).toEqual({ userProfile: true });
      expect(res).toMatchObject({ profile: "user" });
    });
    it("user-profile lock: a second key does not treat the running user-profile app as the user's (temp-profile path)", async () => {
      const t = setup({ running: [11] });
      const first = await t.run("1:");
      expect(first).toMatchObject({ profile: "user" });
      t.findRunning.mockClear();
      t.quit.mockClear();
      t.confirmRestart.mockClear();
      const second = await t.run("2:");
      expect(t.findRunning).not.toHaveBeenCalled();
      expect(t.confirmRestart).not.toHaveBeenCalled();
      expect(t.quit).not.toHaveBeenCalled();
      expect(t.confirm).toHaveBeenCalledTimes(1); // the normal confirm
      expect(t.launch.mock.calls[1][1]).toBeUndefined();
      expect(second).not.toHaveProperty("profile");
    });
    it("the lock is taken BEFORE the restart confirm: a second key during the first key's confirm takes the temp path and never quits", async () => {
      let answer: (v: boolean) => void = () => {};
      const t = setup({ running: [11], confirmRestart: () => new Promise<boolean>((r) => (answer = r)) });
      const first = t.run("1:");
      await vi.waitFor(() => expect(t.confirmRestart).toHaveBeenCalledTimes(1));
      const second = await t.run("2:"); // while key 1's restart dialog is open
      expect(second).not.toHaveProperty("profile");
      expect(t.confirmRestart).toHaveBeenCalledTimes(1);
      expect(t.quit).not.toHaveBeenCalled();
      expect(t.launch.mock.calls.map((c) => c[1])).toEqual([undefined]);
      answer(true);
      expect(await first).toMatchObject({ profile: "user" });
      expect(t.quit.mock.calls.map((c) => c[0])).toEqual([11]);
    });
    it("the lock is released when the restart confirm is denied", async () => {
      const t = setup({ running: [11], confirmRestart: async () => false });
      expect(await t.run("1:")).toEqual({ error: ERR_APP_DENIED });
      const b = t.reg.begin("2:");
      if (!b.ok) throw new Error("begin");
      expect(b.ticket.userProfileHeldElsewhere("/Applications/Orca.app")).toBe(false);
      expect(b.ticket.lockUserProfile("/Applications/Orca.app")).toBe(true);
      b.ticket.abort();
    });
    it("the lock is released when the launch fails (after the app was put back)", async () => {
      const t = setup({ running: [11], launch: async () => { throw new Error("no start"); } });
      expect(await t.run("1:")).toEqual({ error: "no start" });
      expect(t.reopen).toHaveBeenCalledWith("/Applications/Orca.app");
      const b = t.reg.begin("2:");
      if (!b.ok) throw new Error("begin");
      expect(b.ticket.lockUserProfile("/Applications/Orca.app")).toBe(true);
      b.ticket.abort();
    });
    it("the lock is released when the open is cancelled", async () => {
      let quitDone: (v: boolean) => void = () => {};
      const t = setup({ running: [11], quit: () => new Promise<boolean>((r) => (quitDone = r)) });
      const first = t.run("1:");
      await vi.waitFor(() => expect(t.quit).toHaveBeenCalled());
      await t.reg.release("1:");
      quitDone(true);
      expect(await first).toEqual({ error: ERR_APP_RELEASED });
      const b = t.reg.begin("2:");
      if (!b.ok) throw new Error("begin");
      expect(b.ticket.lockUserProfile("/Applications/Orca.app")).toBe(true);
      b.ticket.abort();
    });
    it("on success the lock lives until the user-profile handle's close has fully finished", async () => {
      let finishClose: () => void = () => {};
      const t = setup({ running: [11] });
      t.launch.mockImplementationOnce(async (p: string, o?: { userProfile?: boolean }) => {
        const h = Object.assign(fakeHandle(), { appPath: p, userProfile: o?.userProfile === true });
        h.close.mockImplementation(() => new Promise<void>((r) => (finishClose = r)));
        return h;
      });
      await t.run("1:");
      const probe = () => {
        const b = t.reg.begin("2:");
        if (!b.ok) throw new Error("begin");
        const held = b.ticket.userProfileHeldElsewhere("/Applications/Orca.app");
        b.ticket.abort();
        return held;
      };
      expect(probe()).toBe(true);
      const closing = t.reg.release("1:");
      await new Promise((r) => setTimeout(r, 0));
      expect(probe()).toBe(true); // close still running (e.g. the reopen)
      finishClose();
      await closing;
      expect(probe()).toBe(false);
    });
    it("cancelWaiters(realPath) runs before the first quit", async () => {
      const order: string[] = [];
      const t = setup({ running: [11, 12], quit: async (pid) => { order.push(`quit${pid}`); return true; } });
      t.cancelWaiters.mockImplementation((p: string) => void order.push(`cancel:${p}`));
      await t.run();
      expect(order).toEqual(["cancel:/Applications/Orca.app", "quit11", "quit12"]);
    });
    it("a quit that times out clears the flight's mark: killAllSync spawns nothing for it", async () => {
      const quitReopenDetached = vi.fn();
      const reopenDetached = vi.fn();
      const reg = createAppRegistry<Fake>({ launch: async () => fakeHandle(), quitReopenDetached, reopenDetached });
      const t = setup({ running: [11], quit: async () => false });
      let onTimeout: () => void = () => {};
      const reopenWhenGone = vi.fn();
      const hold = new Promise<void>((r) => (onTimeout = r));
      reopenWhenGone.mockImplementation(() => onTimeout());
      const p = openApp("1:", "x", {
        registry: reg, validate: t.validate, confirm: t.confirm, confirmRestart: t.confirmRestart,
        findRunning: t.findRunning, quit: t.quit, reopen: t.reopen, reopenWhenGone,
      });
      await hold;
      expect(await p).toEqual({ error: errAppDidNotQuit("Orca") });
      reg.killAllSync();
      expect(reopenWhenGone).toHaveBeenCalledTimes(1);
      expect(quitReopenDetached).not.toHaveBeenCalled();
      expect(reopenDetached).not.toHaveBeenCalled();
    });
    it("a denied or failed normal open never reopens", async () => {
      const t = setup({ confirm: async () => false });
      await t.run();
      expect(t.reopen).not.toHaveBeenCalled();
    });
  });
  it("registry livePids lists the pids of spawned apps (the service excludes them from the user's)", async () => {
    let n = 100;
    const reg = createAppRegistry<Fake & { pid: number }>({ launch: async () => ({ ...fakeHandle(), pid: n++ }) });
    const b1 = reg.begin("1:");
    const b2 = reg.begin("2:");
    if (!b1.ok || !b2.ok) throw new Error("begin");
    await b1.ticket.launch("/A");
    await b2.ticket.launch("/B");
    expect(reg.livePids().sort()).toEqual([100, 101]);
    await reg.release("1:");
    expect(reg.livePids()).toEqual([101]);
  });
  it("shapeLaunchResult leaves the temp-profile result unchanged", () => {
    expect(shapeLaunchResult(undefined, "Orca", {})).toEqual({ url: "", title: "", app: "Orca" });
    expect(shapeLaunchResult(undefined, "Orca", { userProfile: true })).toMatchObject({ profile: "user" });
  });
});

describe("user-app helpers", () => {
  it("filterUserPids keeps only default-profile instances that are not ours", () => {
    const res = [
      { pid: 1, userDataDir: null },
      { pid: 2, userDataDir: "/tmp/sideform-app-x" },
      { pid: 3, userDataDir: "/Users/u/other-profile" },
      { pid: 4, userDataDir: null },
    ];
    expect(filterUserPids(res, [4])).toEqual([1]);
    expect(filterUserPids(res, [])).toEqual([1, 4]);
  });
  it("shell helper args keep the path and the pid out of the script text", () => {
    const path = "/Applications/Evil $(rm -rf ~) 'x'.app";
    const args = quitReopenShellArgs(path, 4242);
    expect(args).toEqual(["-c", QUIT_REOPEN_SCRIPT, "sh", path, "4242"]);
    expect(args[1]).not.toContain("Evil");
    expect(args[1]).not.toContain("4242");
    expect(args[1]).toContain('"$SIDEFORM_QUIT_JXA"');
    expect(args[1]).toContain('kill -0 "$2"');
    expect(args[1]).toContain('open -g "$1"');
  });
  it("killHandleSync: temp-profile apps are killed and cleaned; user-profile apps go to the helper only", () => {
    const deps = { kill: vi.fn(), rmProfile: vi.fn(), spawnQuitReopen: vi.fn() };
    killHandleSync({ pid: 5, profileDir: "/tmp/p", appPath: "/A.app", userProfile: false }, deps);
    expect(deps.kill).toHaveBeenCalledWith(5);
    expect(deps.rmProfile).toHaveBeenCalledWith("/tmp/p");
    expect(deps.spawnQuitReopen).not.toHaveBeenCalled();
    const d2 = { kill: vi.fn(), rmProfile: vi.fn(), spawnQuitReopen: vi.fn() };
    killHandleSync({ pid: 6, profileDir: null, appPath: "/B.app", userProfile: true }, d2);
    expect(d2.spawnQuitReopen).toHaveBeenCalledWith("/B.app", 6);
    expect(d2.kill).not.toHaveBeenCalled();
    expect(d2.rmProfile).not.toHaveBeenCalled();
  });
  it("killHandleSync: a user-profile app whose link already dropped (the user quit it) gets no helper", () => {
    const d = { kill: vi.fn(), rmProfile: vi.fn(), spawnQuitReopen: vi.fn() };
    killHandleSync({ pid: 6, profileDir: null, appPath: "/B.app", userProfile: true, disconnected: true }, d);
    expect(d.spawnQuitReopen).not.toHaveBeenCalled();
    expect(d.kill).not.toHaveBeenCalled();
    // a temp-profile app is still killed and cleaned even when disconnected
    killHandleSync({ pid: 7, profileDir: "/tmp/q", appPath: "/C.app", userProfile: false, disconnected: true }, d);
    expect(d.kill).toHaveBeenCalledWith(7);
    expect(d.rmProfile).toHaveBeenCalledWith("/tmp/q");
  });
  it("registry killAllSync: a disconnected live user-profile handle spawns no helper, a connected one does", async () => {
    for (const [disconnected, expected] of [[false, [["/B.app", 1]]], [true, []]] as const) {
      const spawned: [string, number][] = [];
      const mk = () => Object.assign(fakeHandle(), { pid: 1, appPath: "/B.app", userProfile: true, profileDir: null, disconnected });
      const reg = createAppRegistry<ReturnType<typeof mk>>({
        launch: async () => mk(),
        isAlive: () => true,
        killSync: (h) => killHandleSync(h, { kill: vi.fn(), rmProfile: vi.fn(), spawnQuitReopen: (p, pid) => void spawned.push([p, pid]) }),
      });
      const b = reg.begin("1:");
      if (!b.ok) throw new Error("begin");
      // `disconnected` is a plain field here: the registry's own onDisconnected is not fired
      const r = await b.ticket.launch("/B.app", { userProfile: true });
      if (!r.ok) throw new Error("launch");
      reg.killAllSync();
      expect(spawned).toEqual(expected);
    }
  });
  describe("NSWorkspace intersect", () => {
    it("parses the script output", () => {
      expect(parseWorkspacePids("92421")).toEqual([92421]);
      expect(parseWorkspacePids("1, 22,x,-3,0,")).toEqual([1, 22]);
      expect(parseWorkspacePids("")).toEqual([]);
      expect(parseWorkspacePids("\n")).toEqual([]);
    });
    it("keeps only ps pids that are also GUI apps of the bundle", () => {
      expect(intersectWorkspacePids([593, 92421, 92458], "92421\n")).toEqual([92421]);
      expect(intersectWorkspacePids([593, 92458], "92421")).toEqual([]);
      expect(intersectWorkspacePids([593], "")).toEqual([]);
      expect(intersectWorkspacePids([5, 6], "6,5")).toEqual([5, 6]);
    });
    it("passes the path as an argv entry, never inside the script", () => {
      const evil = "/Applications/Evil'\");$(x).app";
      const args = workspacePidsArgs(evil);
      expect(args).toEqual(["-l", "JavaScript", "-e", WORKSPACE_PIDS_JXA, evil]);
      expect(WORKSPACE_PIDS_JXA).not.toContain("Evil");
      expect(WORKSPACE_PIDS_JXA).toContain("argv[0]");
    });
  });
});

describe("user-profile busy and the release decision", () => {
  it("the user-profile lock: one key per real path, same key re-enters, held through the handle's close", async () => {
    const reg = createAppRegistry<Fake & { appPath: string; userProfile: boolean }>({
      launch: async (p, o) => ({ ...fakeHandle(), appPath: p, userProfile: o?.userProfile === true }),
    });
    const one = reg.begin("1:");
    const two = reg.begin("2:");
    if (!one.ok || !two.ok) throw new Error("begin");
    expect(two.ticket.userProfileHeldElsewhere("/A.app")).toBe(false);
    expect(one.ticket.lockUserProfile("/A.app")).toBe(true);
    expect(one.ticket.lockUserProfile("/A.app")).toBe(true);
    expect(two.ticket.userProfileHeldElsewhere("/A.app")).toBe(true);
    expect(two.ticket.lockUserProfile("/A.app")).toBe(false);
    expect(two.ticket.lockUserProfile("/B.app")).toBe(true); // other bundle is independent
    const r = await one.ticket.launch("/A.app", { userProfile: true });
    expect(r.ok).toBe(true);
    expect(two.ticket.userProfileHeldElsewhere("/A.app")).toBe(true); // the live handle keeps it
    await reg.release("1:");
    expect(two.ticket.userProfileHeldElsewhere("/A.app")).toBe(false);
    two.ticket.abort();
  });
  it("a user-profile launch without the lock takes it, or fails when another key holds it", async () => {
    const reg = createAppRegistry<Fake & { appPath: string; userProfile: boolean }>({
      launch: async (p, o) => ({ ...fakeHandle(), appPath: p, userProfile: o?.userProfile === true }),
    });
    const one = reg.begin("1:");
    const two = reg.begin("2:");
    if (!one.ok || !two.ok) throw new Error("begin");
    expect((await one.ticket.launch("/A.app", { userProfile: true })).ok).toBe(true);
    expect(await two.ticket.launch("/A.app", { userProfile: true })).toEqual({ ok: false, error: ERR_APP_PROFILE_BUSY });
    two.ticket.abort();
  });
  it("the helper script skips osascript when the quit script is empty, and still waits and reopens", () => {
    expect(QUIT_REOPEN_SCRIPT).toContain('[ -n "$SIDEFORM_QUIT_JXA" ] && osascript');
    expect(QUIT_REOPEN_SCRIPT).toContain('kill -0 "$2"');
    expect(QUIT_REOPEN_SCRIPT).toContain('open -g "$1"');
  });
  describe("ranAtRelease", () => {
    const run = async (o: { userProfile?: boolean; disconnected: boolean; diesAfterMs?: number }) => {
      let now = 0;
      return ranAtRelease({
        userProfile: o.userProfile ?? true,
        disconnected: o.disconnected,
        isAlive: () => o.diesAfterMs === undefined || now < o.diesAfterMs,
        sleep: async (ms) => { now += ms; },
      });
    };
    it("link still up and process alive: it ran", async () => {
      expect(await run({ disconnected: false })).toBe(true);
    });
    it("temp-profile app or dead process: never reopened", async () => {
      expect(await run({ userProfile: false, disconnected: false })).toBe(false);
      expect(await run({ disconnected: false, diesAfterMs: 0 })).toBe(false);
    });
    it("link dropped and the process exits within 3 s (the user's Cmd+Q): no reopen", async () => {
      expect(await run({ disconnected: true, diesAfterMs: 1500 })).toBe(false);
    });
    it("link dropped but the process stays alive past 3 s: treated as running", async () => {
      expect(await run({ disconnected: true })).toBe(true);
    });
  });
});
