import { describe, expect, it, vi } from "vitest";
import { HelperError } from "../src/main/computerUse/helperClient";
import { createNativeAppController, type CursorSink } from "../src/main/computerUse/nativeController";
import {
  ERR_HELPER_MISSING,
  ERR_NATIVE_NO_CAPTURE,
  ERR_NATIVE_NO_WINDOW,
  ERR_NATIVE_NOT_FRONTMOST,
  ERR_NATIVE_POINT_NOT_IN_APP,
  ERR_NATIVE_SHORTCUT_BLOCKED,
  ERR_NATIVE_OPEN_LOCKED,
  ERR_NATIVE_TABS,
  ERR_NATIVE_UNSUPPORTED,
  ERR_NO_ACCESSIBILITY,
  ERR_NO_SCREEN_RECORDING,
} from "../src/main/computerUse/errors";

type Handler = (args: Record<string, unknown>) => unknown;

const WIN = { windowId: 11, title: "Main", x: 100, y: 50, width: 800, height: 600, onScreen: true, minimized: false, main: true, focused: true };
const EL = [
  { index: 0, tag: "button", label: "Save", ops: ["CLICK"] },
  { index: 1, tag: "button", label: "Save as draft", ops: ["CLICK"] },
  { index: 2, tag: "textfield", label: "Name", ops: ["TYPE_TEXT"], value: "" },
  { index: 3, tag: "popupbutton", label: "Size", ops: ["SELECT"] },
];

function setup(handlers: Record<string, Handler> = {}, extra: Partial<Parameters<typeof createNativeAppController>[0]> = {}) {
  let n = 0;
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const defaults: Record<string, Handler> = {
    windows: () => ({ windows: [WIN] }),
    snapshot: () => ({ snapshotId: `s${++n}`, elements: EL, truncated: false, window: WIN }),
    elementFrame: () => ({ x: 200, y: 100, width: 100, height: 40 }),
    perform: () => ({ done: true, via: "ax" }),
    click: () => ({ done: true }),
    key: () => ({ done: true }),
    type: () => ({ done: true }),
    scroll: () => ({ done: true }),
    move: () => ({ done: true }),
    read: () => ({ title: "Main", text: "hello world", truncated: false }),
    screenshot: () => ({ png: "PNGDATA", width: 1600, height: 900, scale: 2 }),
    permissions: () => ({ accessibility: true, screenRecording: true }),
  };
  const table = { ...defaults, ...handlers };
  const helper = {
    call: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
      calls.push({ cmd, args });
      const h = table[cmd];
      if (!h) throw new Error(`no handler ${cmd}`);
      return h(args) as Record<string, unknown>;
    }),
  };
  const sleep = vi.fn(async () => undefined);
  let clock = 0;
  const now = () => clock;
  const sleepClock = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const ctl = createNativeAppController({ helper, pid: 42, name: "Qure Dev", bundleId: "dev.qure", sleep, now, ...extra });
  const of = (cmd: string) => calls.filter((c) => c.cmd === cmd);
  return { ctl, helper, calls, of, sleep, sleepClock, setClock: () => clock, deps: { now, sleep: sleepClock } };
}

const first = async (ctl: ReturnType<typeof setup>["ctl"]) => (await ctl.snapshot()) as { snapshotId: string };

describe("tabs", () => {
  it("lists on-screen windows with macos-app urls and the focused one current", async () => {
    const hidden = { ...WIN, windowId: 12, onScreen: false };
    const mini = { ...WIN, windowId: 13, minimized: true };
    const other = { ...WIN, windowId: 14, title: "Other", focused: false, main: false };
    const { ctl } = setup({ windows: () => ({ windows: [other, hidden, mini, WIN] }) });
    expect(await ctl.tabs({ action: "list" })).toEqual({
      tabs: [
        { tabId: 14, url: "macos-app://dev.qure/14", title: "Other", current: false },
        { tabId: 11, url: "macos-app://dev.qure/11", title: "Main", current: true },
      ],
      current: 11,
    });
    expect(ctl.currentWindowId()).toBe(11);
  });

  it("falls back to the main window, then the first, and uses the name without a bundle id", async () => {
    const a = { ...WIN, windowId: 1, focused: false, main: false };
    const b = { ...WIN, windowId: 2, focused: false, main: true };
    const { ctl } = setup({ windows: () => ({ windows: [a, b] }) });
    const r = (await ctl.tabs({ action: "list" })) as { current: number };
    expect(r.current).toBe(2);
    const noMain = setup({ windows: () => ({ windows: [a] }) }, { bundleId: undefined });
    const r2 = (await noMain.ctl.tabs({ action: "list" })) as { tabs: { url: string }[] };
    expect(r2.tabs[0].url).toBe("macos-app://Qure Dev/1");
  });

  it("switch makes the window current and later calls use it", async () => {
    const other = { ...WIN, windowId: 14, title: "Other", focused: false, main: false };
    const { ctl, of } = setup({ windows: () => ({ windows: [WIN, other] }) });
    const r = (await ctl.tabs({ action: "switch", tabId: 14 })) as { current: number };
    expect(r.current).toBe(14);
    await ctl.snapshot();
    expect(of("snapshot")[0].args.windowId).toBe(14);
    expect(await ctl.tabs({ action: "switch", tabId: 99 })).toEqual({ error: expect.stringContaining("99") });
  });

  it("leaves out windowId 0 entries unless every window is 0", async () => {
    const zero = { ...WIN, windowId: 0, title: "Stub", focused: true };
    const a = setup({ windows: () => ({ windows: [zero, { ...WIN, focused: false }] }) });
    const r = (await a.ctl.tabs({ action: "list" })) as { tabs: { tabId: number }[]; current: number };
    expect(r.tabs.map((t) => t.tabId)).toEqual([11]);
    expect(r.current).toBe(11);
    const b = setup({ windows: () => ({ windows: [zero] }) });
    const r2 = (await b.ctl.tabs({ action: "list" })) as { tabs: { tabId: number }[] };
    expect(r2.tabs.map((t) => t.tabId)).toEqual([0]);
  });

  it("re-lists and re-picks the window once when the helper says NO_WINDOW for the cached one", async () => {
    const other = { ...WIN, windowId: 21, title: "Other" };
    let windows = [WIN];
    let snapshots = 0;
    const { ctl, of } = setup({
      windows: () => ({ windows }),
      snapshot: (a) => {
        snapshots++;
        if (a.windowId === 11 && snapshots > 1) throw new HelperError("gone", "NO_WINDOW");
        return { snapshotId: `s${snapshots}`, elements: EL, window: windows[0] };
      },
    });
    await ctl.snapshot();
    expect(ctl.currentWindowId()).toBe(11);
    windows = [other];
    const r = (await ctl.snapshot()) as { url: string };
    expect(r.url).toBe("macos-app://dev.qure/21");
    expect(of("snapshot").map((c) => c.args.windowId)).toEqual([11, 11, 21]);
    expect(ctl.currentWindowId()).toBe(21);
  });

  it("gives up with the no-window text when the retry fails too", async () => {
    const { ctl, of } = setup({
      snapshot: () => {
        throw new HelperError("gone", "NO_WINDOW");
      },
    });
    expect(await ctl.snapshot()).toEqual({ error: ERR_NATIVE_NO_WINDOW });
    expect(of("snapshot")).toHaveLength(2);
  });

  it("leaves out zero-area windows (Finder's desktop) and then reports no window", async () => {
    const desktop = { ...WIN, windowId: 0, width: 0, height: 0 };
    const { ctl, of } = setup({ windows: () => ({ windows: [desktop, { ...desktop, windowId: 25 }] }) });
    expect(await ctl.tabs({ action: "list" })).toEqual({ tabs: [], current: null });
    expect(await ctl.snapshot()).toEqual({ error: ERR_NATIVE_NO_WINDOW });
    expect(of("snapshot")).toHaveLength(0);
  });

  it("does not ask the helper to capture a window without a CG id", async () => {
    const { ctl, of } = setup({ windows: () => ({ windows: [{ ...WIN, windowId: 0 }] }) });
    expect(await ctl.screenshot({})).toEqual({ error: ERR_NATIVE_NO_CAPTURE });
    expect(of("screenshot")).toHaveLength(0);
  });

  it("close and new are refused", async () => {
    const { ctl, helper } = setup();
    expect(await ctl.tabs({ action: "close", tabId: 11 })).toEqual({ error: ERR_NATIVE_TABS });
    expect(await ctl.tabs({ action: "new" })).toEqual({ error: ERR_NATIVE_TABS });
    expect(helper.call).not.toHaveBeenCalled();
  });

  it("reports no window", async () => {
    const { ctl } = setup({ windows: () => ({ windows: [] }) });
    expect(await ctl.snapshot()).toEqual({ error: ERR_NATIVE_NO_WINDOW });
  });
});

describe("locked and unsupported operations", () => {
  it("open is locked", async () => {
    const { ctl } = setup();
    expect(await ctl.open({ url: "https://x.test" })).toEqual({ error: ERR_NATIVE_OPEN_LOCKED });
  });

  it("findImages, assert and requests are unsupported", async () => {
    const { ctl } = setup();
    expect(await ctl.findImages({})).toEqual({ error: ERR_NATIVE_UNSUPPORTED("findImages") });
    expect(await ctl.assert({})).toEqual({ error: ERR_NATIVE_UNSUPPORTED("assert") });
    expect(await ctl.requests()).toEqual({ error: ERR_NATIVE_UNSUPPORTED("requests") });
  });

  it.each(["back", "forward", "reload", "upload", "viewport"])("act %s is unsupported", async (action) => {
    const { ctl } = setup();
    expect(await ctl.act({ action })).toEqual({ error: ERR_NATIVE_UNSUPPORTED(action) });
  });
});

describe("snapshot and read", () => {
  it("returns the browser snapshot shape plus a fixed scroll", async () => {
    const { ctl, of } = setup();
    expect(await ctl.snapshot()).toEqual({
      snapshotId: "s1",
      url: "macos-app://dev.qure/11",
      title: "Main",
      elements: EL,
      scroll: { y: 0, height: 0, atBottom: true },
    });
    expect(of("snapshot")[0].args).toEqual({ pid: 42, windowId: 11, maxElements: 120 });
  });

  it("carries truncated when the helper truncates", async () => {
    const { ctl } = setup({ snapshot: () => ({ snapshotId: "s", elements: [], truncated: true, window: WIN }) });
    expect(await ctl.snapshot()).toMatchObject({ truncated: true });
  });

  it("read returns text with maxChars 12000", async () => {
    const { ctl, of } = setup();
    expect(await ctl.read({})).toEqual({ url: "macos-app://dev.qure/11", title: "Main", text: "hello world", truncated: false });
    expect(of("read")[0].args).toEqual({ pid: 42, windowId: 11, maxChars: 12000 });
  });
});

describe("blocked shortcuts", () => {
  it("refuses app and system shortcuts before any helper call", async () => {
    for (const key of ["Meta+q", "cmd+w", "Meta+Alt+h", "Control+Space", "Meta+Tab", "F3"]) {
      const { ctl, helper } = setup();
      const r = (await ctl.act({ action: "press", key })) as { error: string };
      expect(r.error).toBe(ERR_NATIVE_SHORTCUT_BLOCKED(key));
      expect(r.error).toContain("quit or switch the app");
      expect(helper.call).not.toHaveBeenCalled();
    }
  });

  it("refuses a whole batch that holds a blocked key before running any step", async () => {
    const { ctl, of } = setup();
    const r = (await ctl.act({ actions: [{ action: "click", target: "Save" }, { action: "press", key: "Meta+q" }] })) as { error: string };
    expect(r.error).toContain("Action 2 of 2 failed");
    expect(of("perform")).toHaveLength(0);
    expect(of("key")).toHaveLength(0);
  });

  it("still sends ordinary keys", async () => {
    const { ctl, of } = setup();
    await ctl.act({ action: "press", key: "Meta+a" });
    expect(of("key")[0].args).toMatchObject({ pid: 42, key: "Meta+a" });
  });
});

describe("helper error codes", () => {
  it("maps NOT_FRONTMOST and POINT_NOT_IN_APP to their messages", async () => {
    const a = setup({ perform: () => { throw new HelperError("x", "NOT_FRONTMOST"); } });
    const s = await first(a.ctl);
    expect(await a.ctl.perform({ operation: "CLICK", snapshotId: s.snapshotId, index: 0 })).toEqual({ error: ERR_NATIVE_NOT_FRONTMOST });
    const b = setup({ perform: () => { throw new HelperError("x", "NO_ACTION"); }, click: () => { throw new HelperError("x", "POINT_NOT_IN_APP"); } });
    const s2 = await first(b.ctl);
    expect(await b.ctl.perform({ operation: "CLICK", snapshotId: s2.snapshotId, index: 0 })).toEqual({ error: ERR_NATIVE_POINT_NOT_IN_APP });
  });
});

describe("perform", () => {
  it("CLICK presses through the accessibility action", async () => {
    const { ctl, of } = setup();
    const s = await first(ctl);
    const r = await ctl.perform({ snapshotId: s.snapshotId, index: 0, operation: "CLICK" });
    expect(r).toMatchObject({ done: true, via: "ax" });
    expect(of("perform")[0].args).toEqual({ pid: 42, snapshotId: "s1", index: 0, action: "press" });
    expect(of("click")).toHaveLength(0);
  });

  it("CLICK falls back to a click at the element centre on NO_ACTION", async () => {
    const { ctl, of } = setup({
      perform: () => {
        throw new HelperError("no press", "NO_ACTION");
      },
    });
    const s = await first(ctl);
    const r = await ctl.perform({ snapshotId: s.snapshotId, index: 0, operation: "CLICK" });
    expect(r).toMatchObject({ done: true, via: "event" });
    expect(of("elementFrame")[0].args).toEqual({ pid: 42, snapshotId: "s1", index: 0 });
    expect(of("click")[0].args).toEqual({ pid: 42, x: 250, y: 120 });
  });

  it("TYPE_TEXT focuses, sets the value and keeps it when read back", async () => {
    let n = 0;
    const { ctl, of } = setup({
      snapshot: () => {
        n++;
        return { snapshotId: `s${n}`, elements: EL.map((e) => (e.index === 2 && n > 1 ? { ...e, value: "Ada" } : e)), window: WIN };
      },
    });
    const s = await first(ctl);
    await ctl.perform({ snapshotId: s.snapshotId, index: 2, operation: "TYPE_TEXT", text: "Ada" });
    expect(of("perform").map((c) => c.args.action)).toEqual(["focus", "setValue"]);
    expect(of("perform")[1].args.text).toBe("Ada");
    expect(of("key")).toHaveLength(0);
    expect(of("type")).toHaveLength(0);
  });

  it("TYPE_TEXT falls back to Meta+a and typing when the value did not stick", async () => {
    const { ctl, of } = setup();
    const s = await first(ctl);
    const r = await ctl.perform({ snapshotId: s.snapshotId, index: 2, operation: "TYPE_TEXT", text: "Ada" });
    expect(r).toMatchObject({ via: "event" });
    expect(of("key")[0].args).toMatchObject({ pid: 42, key: "Meta+a" });
    expect(of("type")[0].args).toEqual({ pid: 42, text: "Ada" });
  });

  it("TYPE_TEXT falls back when setValue is refused", async () => {
    const { ctl, of } = setup({
      perform: (a) => {
        if (a.action === "setValue") throw new HelperError("no", "NO_ACTION");
        return { done: true };
      },
    });
    const s = await first(ctl);
    await ctl.perform({ snapshotId: s.snapshotId, index: 2, operation: "TYPE_TEXT", text: "x" });
    expect(of("type")).toHaveLength(1);
  });

  describe("TYPE_TEXT read-back with shifting indices", () => {
    const SECURE = { index: 4, tag: "securetextfield", label: "Password", ops: ["TYPE_TEXT"], isPassword: true, hasValue: false };
    const shifted = (fresh: unknown[]) => {
      let n = 0;
      return () => ({ snapshotId: `s${++n}`, elements: n === 1 ? [...EL, SECURE] : fresh, window: WIN });
    };

    it("finds the same element by tag and label when its index moved", async () => {
      const moved = [{ index: 0, tag: "button", label: "New" }, ...EL.map((e) => ({ ...e, index: e.index + 1 })).map((e) => (e.label === "Name" ? { ...e, value: "Ada" } : e))];
      const { ctl, of } = setup({ snapshot: shifted(moved) });
      const s = await first(ctl);
      const r = await ctl.perform({ snapshotId: s.snapshotId, index: 2, operation: "TYPE_TEXT", text: "Ada" });
      expect(r).toMatchObject({ via: "ax" });
      expect(of("key")).toHaveLength(0);
      expect(of("type")).toHaveLength(0);
    });

    it("does not trust a different element left at the same index", async () => {
      const other = EL.map((e) => (e.index === 2 ? { index: 2, tag: "textfield", label: "Other", ops: ["TYPE_TEXT"], value: "Ada" } : e));
      const { ctl, of } = setup({ snapshot: shifted(other) });
      const s = await first(ctl);
      const r = await ctl.perform({ snapshotId: s.snapshotId, index: 2, operation: "TYPE_TEXT", text: "Ada" });
      expect(r).toMatchObject({ via: "ax", verified: false });
      expect(of("key")).toHaveLength(0);
      expect(of("type")).toHaveLength(0);
    });

    it("reports unverified, without retyping, when the element is gone or ambiguous", async () => {
      const dup = [...EL, { index: 9, tag: "textfield", label: "Name", ops: ["TYPE_TEXT"], value: "" }].map((e) => (e.index === 2 ? { ...e, index: 7 } : e));
      const { ctl, of } = setup({ snapshot: shifted(dup) });
      const s = await first(ctl);
      const r = await ctl.perform({ snapshotId: s.snapshotId, index: 2, operation: "TYPE_TEXT", text: "Ada" });
      expect(r).toMatchObject({ via: "ax", verified: false });
      expect(of("key")).toHaveLength(0);
      const gone = setup({ snapshot: shifted(EL.filter((e) => e.label !== "Name")) });
      const s2 = await first(gone.ctl);
      const r2 = await gone.ctl.perform({ snapshotId: s2.snapshotId, index: 2, operation: "TYPE_TEXT", text: "Ada" });
      expect(r2).toMatchObject({ via: "ax", verified: false });
      expect(gone.of("type")).toHaveLength(0);
    });

    it("secure field: verified only when hasValue went false to true", async () => {
      const ok = setup({ snapshot: shifted([...EL, { ...SECURE, hasValue: true }]) });
      const s = await first(ok.ctl);
      const r = await ok.ctl.perform({ snapshotId: s.snapshotId, index: 4, operation: "TYPE_TEXT", text: "pw" });
      expect(r).toMatchObject({ via: "ax" });
      expect(r).not.toHaveProperty("verified");
      expect(ok.of("type")).toHaveLength(0);
    });

    it("secure field already filled before: unverified, never retyped", async () => {
      let n = 0;
      const filled = { ...SECURE, hasValue: true };
      const { ctl, of } = setup({ snapshot: () => ({ snapshotId: `s${++n}`, elements: [...EL, filled], window: WIN }) });
      const s = await first(ctl);
      const r = await ctl.perform({ snapshotId: s.snapshotId, index: 4, operation: "TYPE_TEXT", text: "pw" });
      expect(r).toMatchObject({ via: "ax", verified: false });
      expect(of("key")).toHaveLength(0);
      expect(of("type")).toHaveLength(0);
    });

    it("secure field that stayed empty falls back to typing", async () => {
      let n = 0;
      const { ctl, of } = setup({ snapshot: () => ({ snapshotId: `s${++n}`, elements: [...EL, SECURE], window: WIN }) });
      const s = await first(ctl);
      const r = await ctl.perform({ snapshotId: s.snapshotId, index: 4, operation: "TYPE_TEXT", text: "pw" });
      expect(r).toMatchObject({ via: "event" });
      expect(of("type")).toHaveLength(1);
    });
  });

  it("SELECT picks the option", async () => {
    const { ctl, of } = setup();
    const s = await first(ctl);
    await ctl.perform({ snapshotId: s.snapshotId, index: 3, operation: "SELECT", text: "Large" });
    expect(of("perform")[0].args).toEqual({ pid: 42, snapshotId: "s1", index: 3, action: "pick", text: "Large" });
  });

  it("SCROLL scrolls at the element centre, or the window centre without an index", async () => {
    const { ctl, of } = setup();
    const s = await first(ctl);
    await ctl.perform({ snapshotId: s.snapshotId, index: 3, operation: "SCROLL_DOWN" });
    expect(of("scroll")[0].args).toMatchObject({ pid: 42, x: 250, y: 120 });
    expect(of("scroll")[0].args.dy as number).toBeGreaterThan(0);
    await ctl.perform({ snapshotId: s.snapshotId, operation: "SCROLL_UP" });
    expect(of("scroll")[1].args).toMatchObject({ x: 500, y: 350 });
    expect(of("scroll")[1].args.dy as number).toBeLessThan(0);
  });

  it("rejects a missing snapshotId and an unknown operation", async () => {
    const { ctl } = setup();
    expect(await ctl.perform({ operation: "CLICK", index: 0 })).toEqual({ error: expect.stringContaining("snapshotId") });
    expect(await ctl.perform({ snapshotId: "s", operation: "DANCE" })).toEqual({ error: expect.stringContaining("DANCE") });
  });
});

describe("act", () => {
  it("clicks by exact label before substring and returns the act result shape", async () => {
    let n = 0;
    const { ctl, of } = setup({
      snapshot: () => {
        n++;
        return { snapshotId: `s${n}`, elements: n > 1 ? [...EL, { index: 4, label: "Saved" }] : EL, window: WIN };
      },
    });
    const r = (await ctl.act({ action: "click", target: "  save " })) as Record<string, unknown>;
    expect(of("perform")[0].args).toMatchObject({ index: 0, action: "press" });
    expect(r).toMatchObject({ url: "macos-app://dev.qure/11", title: "Main", matched: "Save", changed: true });
    expect(r.snapshot).toMatchObject({ snapshotId: "s2", scroll: { atBottom: true } });
  });

  it("falls back to a substring match and reports changed false for an identical table", async () => {
    const { ctl, of } = setup();
    const r = (await ctl.act({ action: "click", target: "draft" })) as Record<string, unknown>;
    expect(of("perform")[0].args).toMatchObject({ index: 1 });
    expect(r).toMatchObject({ matched: "Save as draft", changed: false });
  });

  it("reports an unmatched target", async () => {
    const { ctl } = setup();
    expect(await ctl.act({ action: "click", target: "Nope" })).toEqual({ error: expect.stringContaining('"Nope"') });
  });

  it("types and selects by index and snapshotId", async () => {
    const { ctl, of } = setup();
    await ctl.act({ action: "select", index: 3, snapshotId: "sX", text: "Large" });
    expect(of("perform")[0].args).toEqual({ pid: 42, snapshotId: "sX", index: 3, action: "pick", text: "Large" });
    await ctl.act({ action: "type", target: "name", text: "Ada" });
    expect(of("perform").some((c) => c.args.action === "focus" && c.args.index === 2)).toBe(true);
  });

  it("presses a key, hovers and scrolls", async () => {
    const { ctl, of } = setup();
    await ctl.act({ action: "press", key: "Enter" });
    expect(of("key")[0].args).toMatchObject({ pid: 42, key: "Enter" });
    await ctl.act({ action: "hover", target: "Name" });
    expect(of("move")[0].args).toEqual({ pid: 42, x: 250, y: 120 });
    await ctl.act({ action: "scroll", amount: 2 });
    expect(of("scroll")[0].args.dy as number).toBeGreaterThan(0);
  });

  it("runs a batch and stops at the first error", async () => {
    const { ctl, of } = setup();
    const r = await ctl.act({
      actions: [
        { action: "press", key: "Tab" },
        { action: "click", target: "Missing" },
        { action: "press", key: "Enter" },
      ],
    });
    expect(r).toEqual({ error: expect.stringContaining("Action 2 of 3") });
    expect(of("key")).toHaveLength(1);
  });

  it("refuses a batch over 10 actions", async () => {
    const { ctl } = setup();
    const actions = Array.from({ length: 11 }, () => ({ action: "press", key: "a" }));
    expect(await ctl.act({ actions })).toEqual({ error: expect.stringContaining("10") });
  });

  it("wait caps ms at 15000", async () => {
    const { ctl, sleep } = setup();
    await ctl.act({ action: "wait", ms: 60000 });
    expect(sleep).toHaveBeenCalledWith(15000);
  });

  it("wait with text polls read until the text shows up", async () => {
    let reads = 0;
    const s = setup({ read: () => ({ title: "", text: ++reads < 3 ? "loading" : "All Done", truncated: false }) });
    const ctl = createNativeAppController({ helper: s.helper, pid: 42, name: "A", sleep: s.deps.sleep, now: s.deps.now });
    const r = (await ctl.act({ action: "wait", text: "all done" })) as Record<string, unknown>;
    expect(r.error).toBeUndefined();
    expect(reads).toBe(3);
  });

  it("wait with text times out with an error", async () => {
    const s = setup();
    const ctl = createNativeAppController({ helper: s.helper, pid: 42, name: "A", sleep: s.deps.sleep, now: s.deps.now });
    expect(await ctl.act({ action: "wait", text: "never", ms: 1000 })).toEqual({ error: expect.stringContaining("never") });
  });
});

describe("error mapping", () => {
  it("maps STALE to a message that asks for a new snapshot", async () => {
    const { ctl } = setup({
      perform: () => {
        throw new HelperError("unknown snapshot", "STALE");
      },
    });
    const r = (await ctl.perform({ snapshotId: "old", index: 0, operation: "CLICK" })) as { error: string };
    expect(r.error).toContain("browse_snapshot");
  });

  it.each([
    ["NO_ACCESSIBILITY", ERR_NO_ACCESSIBILITY],
    ["NO_WINDOW", ERR_NATIVE_NO_WINDOW],
    ["HELPER_SPAWN", ERR_HELPER_MISSING],
    ["NO_SCREEN_RECORDING", ERR_NO_SCREEN_RECORDING],
  ])("maps %s", async (code, text) => {
    const { ctl } = setup({
      snapshot: () => {
        throw new HelperError("raw", code);
      },
    });
    expect(await ctl.snapshot()).toEqual({ error: text });
  });

  it("passes other helper messages through", async () => {
    const { ctl } = setup({
      read: () => {
        throw new HelperError("AX blew up", "AX_FAILED");
      },
    });
    expect(await ctl.read({})).toEqual({ error: "AX blew up" });
  });

  it("never throws when the helper rejects with a plain error", async () => {
    const { ctl } = setup({
      windows: () => {
        throw new Error("boom");
      },
    });
    for (const p of [ctl.snapshot(), ctl.read({}), ctl.screenshot({}), ctl.tabs({ action: "list" }), ctl.act({ action: "wait" }), ctl.perform({ snapshotId: "s", operation: "CLICK", index: 0 })]) {
      expect(await p).toEqual({ error: "boom" });
    }
  });
});

describe("screenshot", () => {
  it("encodes the helper PNG and returns the tab screenshot shape", async () => {
    const encodeImage = vi.fn(() => ({ data: "JPG", width: 1280, height: 720, mimeType: "image/jpeg" }));
    const { ctl, of } = setup({}, { encodeImage });
    expect(await ctl.screenshot({})).toEqual({
      imageData: "data:image/jpeg;base64,JPG",
      width: 1280,
      height: 720,
      url: "macos-app://dev.qure/11",
      title: "Main",
    });
    expect(of("screenshot")[0].args).toEqual({ windowId: 11, maxWidth: 1280 });
    expect(encodeImage).toHaveBeenCalledWith("PNGDATA", 1280);
  });

  it("returns the PNG unchanged by default", async () => {
    const { ctl } = setup();
    expect(await ctl.screenshot({})).toMatchObject({ imageData: "data:image/png;base64,PNGDATA", width: 1600, height: 900 });
  });

  it("annotate adds snapshotId and elements of a fresh snapshot", async () => {
    const { ctl } = setup();
    expect(await ctl.screenshot({ annotate: true })).toMatchObject({ snapshotId: "s1", marked: EL.length, elements: EL });
  });

  it("asks macOS to prompt and returns the error without Screen Recording", async () => {
    const { ctl, of } = setup({
      screenshot: () => {
        throw new HelperError("denied", "NO_SCREEN_RECORDING");
      },
    });
    expect(await ctl.screenshot({})).toEqual({ error: ERR_NO_SCREEN_RECORDING });
    expect(of("permissions")[0].args).toEqual({ prompt: true });
  });

  it("still returns the error when the prompt itself fails", async () => {
    const { ctl } = setup({
      screenshot: () => {
        throw new HelperError("denied", "NO_SCREEN_RECORDING");
      },
      permissions: () => {
        throw new Error("nope");
      },
    });
    expect(await ctl.screenshot({})).toEqual({ error: ERR_NO_SCREEN_RECORDING });
  });
});

describe("agent cursor", () => {
  it("moves to the element centre with click true for a click and false for hover", async () => {
    const cursor: CursorSink = { moveTo: vi.fn() };
    const { ctl } = setup({}, { cursor });
    const s = await first(ctl);
    await ctl.perform({ snapshotId: s.snapshotId, index: 0, operation: "CLICK" });
    expect(cursor.moveTo).toHaveBeenLastCalledWith({ x: 250, y: 120 }, { click: true, windowFrame: { x: 100, y: 50, width: 800, height: 600 } });
    await ctl.act({ action: "hover", index: 2, snapshotId: s.snapshotId });
    expect(cursor.moveTo).toHaveBeenLastCalledWith({ x: 250, y: 120 }, expect.objectContaining({ click: false }));
  });

  it("a throwing cursor does not fail the action", async () => {
    const cursor: CursorSink = {
      moveTo: () => {
        throw new Error("overlay gone");
      },
    };
    const { ctl } = setup({}, { cursor });
    const s = await first(ctl);
    expect(await ctl.perform({ snapshotId: s.snapshotId, index: 0, operation: "CLICK" })).toMatchObject({ done: true });
  });
});
