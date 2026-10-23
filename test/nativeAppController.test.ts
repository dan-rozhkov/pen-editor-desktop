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
  ERR_NATIVE_CHECK_NO_INDEX,
  ERR_NATIVE_CHECK_CUT,
  ERR_NATIVE_CHECK_NO_CHECKED,
  ERR_NATIVE_CHECK_NO_VALUE,
  ERR_NATIVE_CHECK_NO_LABEL,
  ERR_NATIVE_CHECK_EMPTY_TEXT,
  ERR_NATIVE_CHECK_AMBIGUOUS,
  ERR_NATIVE_TEXT_ABSENT_CUT,
  ERR_NATIVE_CHECK_UNSUPPORTED,
  NATIVE_LIST_TRUNCATED_NOTE,
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

  it("findImages and requests are unsupported", async () => {
    const { ctl } = setup();
    expect(await ctl.findImages({})).toEqual({ error: ERR_NATIVE_UNSUPPORTED("findImages") });
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
  it("moves to the element centre with the action kind of each operation", async () => {
    const cursor: CursorSink = { moveTo: vi.fn() };
    const { ctl } = setup({}, { cursor });
    const s = await first(ctl);
    await ctl.perform({ snapshotId: s.snapshotId, index: 0, operation: "CLICK" });
    expect(cursor.moveTo).toHaveBeenLastCalledWith({ x: 250, y: 120 }, { action: "click", windowFrame: { x: 100, y: 50, width: 800, height: 600 } });
    await ctl.act({ action: "hover", index: 2, snapshotId: s.snapshotId });
    expect(cursor.moveTo).toHaveBeenLastCalledWith({ x: 250, y: 120 }, expect.objectContaining({ action: "hover" }));
  });

  it("passes type and scroll actions", async () => {
    const cursor: CursorSink = { moveTo: vi.fn() };
    const { ctl } = setup({}, { cursor });
    const s = await first(ctl);
    await ctl.perform({ snapshotId: s.snapshotId, index: 0, operation: "TYPE_TEXT", text: "hi" });
    expect(cursor.moveTo).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ action: "type" }));
    await ctl.perform({ snapshotId: s.snapshotId, index: 0, operation: "SCROLL_DOWN" });
    expect(cursor.moveTo).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ action: "scroll" }));
  });

  it("awaits the cursor before acting, and a rejecting cursor does not fail the action", async () => {
    const cursor: CursorSink = { moveTo: () => Promise.reject(new Error("overlay gone")) };
    const { ctl } = setup({}, { cursor });
    const s = await first(ctl);
    expect(await ctl.perform({ snapshotId: s.snapshotId, index: 0, operation: "CLICK" })).toMatchObject({ done: true });
  });

  it("a CLICK that falls back to an event click aims the cursor once", async () => {
    const cursor: CursorSink = { moveTo: vi.fn() };
    const { ctl, of } = setup(
      {
        perform: () => {
          throw new HelperError("no press", "NO_ACTION");
        },
      },
      { cursor },
    );
    const s = await first(ctl);
    expect(await ctl.perform({ snapshotId: s.snapshotId, index: 0, operation: "CLICK" })).toMatchObject({ done: true, via: "event" });
    expect(cursor.moveTo).toHaveBeenCalledTimes(1);
    expect(of("click")[0].args).toEqual({ pid: 42, x: 250, y: 120 });
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

describe("target search beyond the model-sized snapshot", () => {
  const RUN = { index: 500, tag: "button", label: "Run", ops: ["CLICK"] };
  function truncatedSetup(smallTruncated: boolean) {
    return setup({
      snapshot: (a) =>
        a.maxElements === 1000
          ? { snapshotId: "big1", elements: [...EL, RUN], truncated: false, window: WIN }
          : { snapshotId: "small1", elements: EL, truncated: smallTruncated, window: WIN },
    });
  }

  it("searches a 1000-element snapshot and acts on its snapshotId and index", async () => {
    const { ctl, of } = truncatedSetup(true);
    const res = (await ctl.act({ action: "click", target: "Run" })) as { matched?: string; snapshot: { elements: unknown[] } };
    expect(res.matched).toBe("Run");
    expect(of("snapshot").map((c) => c.args.maxElements)).toEqual([120, 1000, 120]);
    expect(of("perform")[0].args).toMatchObject({ snapshotId: "big1", index: 500, action: "press" });
    // The big element list never reaches the model.
    expect(res.snapshot.elements).toEqual(EL);
  });

  it("takes no second snapshot when the first one is not truncated", async () => {
    const { ctl, of } = truncatedSetup(false);
    expect(await ctl.act({ action: "click", target: "Run" })).toMatchObject({ error: expect.stringContaining("No element matched target") });
    expect(of("snapshot").some((c) => c.args.maxElements === 1000)).toBe(false);
  });

  it("still fails when the big snapshot has no match", async () => {
    const { ctl } = truncatedSetup(true);
    expect(await ctl.act({ action: "click", target: "Nothing here" })).toMatchObject({ error: expect.stringContaining("No element matched target") });
  });

  it("adds a note only when the list is truncated", async () => {
    const t = truncatedSetup(true);
    expect(await t.ctl.snapshot()).toMatchObject({ truncated: true, note: NATIVE_LIST_TRUNCATED_NOTE(120, 1000) });
    expect(NATIVE_LIST_TRUNCATED_NOTE(120, 1000)).toContain("The list stops at 120 elements;");
    expect(NATIVE_LIST_TRUNCATED_NOTE(120, 1000)).toContain("up to 1000 elements, by label");
    const f = truncatedSetup(false);
    expect(await f.ctl.snapshot()).not.toHaveProperty("note");
  });
});

describe("assert (QA checks)", () => {
  const check = (c: Record<string, unknown>) => c;

  it("text: pass, fail, absent, case and whitespace", async () => {
    const { ctl } = setup({ read: () => ({ title: "Main", text: "Hello\n  World", truncated: false }) });
    const r = (await ctl.assert({
      checks: [check({ type: "text", text: "hello world" }), check({ type: "text", text: "nope" }), check({ type: "text", text: "nope", absent: true }), check({ type: "text", text: "WORLD", absent: true })],
    })) as { ok: boolean; passed: boolean; results: { passed: boolean; actual?: string }[] };
    expect(r.ok).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.results.map((x) => x.passed)).toEqual([true, false, true, false]);
    expect(r.results[1].actual).toBe("not found");
    expect(r.results[3].actual).toBe("found");
  });

  it("text: one read with a large cap, and truncated is named in actual", async () => {
    const { ctl, of } = setup({ read: () => ({ title: "Main", text: "abc", truncated: true }) });
    const r = (await ctl.assert({ checks: [{ type: "text", text: "x" }, { type: "text", text: "y" }] })) as { results: { actual?: string }[] };
    expect(of("read")).toHaveLength(1);
    expect(of("read")[0].args.maxChars).toBe(100000);
    expect(r.results[0].actual).toContain("cut");
    expect(r.results[0].actual!.length).toBeLessThanOrEqual(120);
  });

  it("element by index: exists, absent, checked, disabled", async () => {
    const els = [
      { index: 0, tag: "checkbox", label: "Agree", ops: ["CLICK"], checked: true },
      { index: 1, tag: "button", label: "Go", ops: ["CLICK"], disabled: true },
      { index: 2, tag: "button", label: "Gone", ops: ["CLICK"] },
    ];
    let phase = 0;
    const { ctl } = setup({
      snapshot: () => ({ snapshotId: `s${phase}`, elements: phase === 0 ? els : els.slice(0, 2), truncated: false, window: WIN }),
    });
    await ctl.snapshot();
    phase = 1;
    const r = (await ctl.assert({
      checks: [
        { type: "element", index: 0, state: "exists" },
        { type: "element", index: 0, state: "checked" },
        { type: "element", index: 0, state: "unchecked" },
        { type: "element", index: 1, state: "disabled" },
        { type: "element", index: 1, state: "enabled" },
        { type: "element", index: 2, state: "absent" },
        { type: "element", index: 2, state: "exists" },
      ],
    })) as { results: { passed: boolean; actual?: string }[] };
    expect(r.results.map((x) => x.passed)).toEqual([true, true, false, true, false, true, false]);
    expect(r.results[6].actual).toBe("not found");
  });

  it("element by index: re-identifies when the index shifts", async () => {
    let shifted = false;
    const { ctl, of } = setup({
      snapshot: () => ({
        snapshotId: shifted ? "s2" : "s1",
        elements: shifted ? [{ index: 0, tag: "button", label: "New", ops: ["CLICK"] }, { ...EL[0], index: 1 }] : EL,
        truncated: false,
        window: WIN,
      }),
    });
    await ctl.snapshot();
    shifted = true;
    const r = (await ctl.assert({ checks: [{ type: "element", index: 0, state: "visible" }] })) as { results: { passed: boolean }[] };
    expect(r.results[0].passed).toBe(true);
    expect(of("snapshot").at(-1)?.args.maxElements).toBe(1000);
  });

  it("index not in the latest snapshot", async () => {
    const { ctl } = setup();
    const before = (await ctl.assert({ checks: [{ type: "element", index: 1, state: "exists" }] })) as { passed: boolean; results: { error?: string }[] };
    expect(before.passed).toBe(false);
    expect(before.results[0].error).toBe(ERR_NATIVE_CHECK_NO_INDEX(1));
    await ctl.snapshot();
    const after = (await ctl.assert({ checks: [{ type: "value", index: 99, equals: "x" }] })) as { results: { error?: string }[] };
    expect(after.results[0].error).toBe(ERR_NATIVE_CHECK_NO_INDEX(99));
  });

  it("value: equals and contains", async () => {
    const field = (v: string) => [{ index: 0, tag: "textfield", label: "Name", ops: ["TYPE_TEXT"], value: v }];
    let v = "";
    const { ctl } = setup({ snapshot: () => ({ snapshotId: "s", elements: field(v), truncated: false, window: WIN }) });
    await ctl.snapshot();
    v = "Alice Smith";
    const r = (await ctl.assert({
      checks: [{ type: "value", index: 0, equals: "Alice Smith" }, { type: "value", index: 0, contains: "ice" }, { type: "value", index: 0, equals: "Alice" }],
    })) as { results: { passed: boolean; actual?: string }[] };
    expect(r.results.map((x) => x.passed)).toEqual([true, true, false]);
    expect(r.results[2].actual).toBe('value "Alice Smith"');
  });

  it("selector, count and url checks fail with the unsupported text", async () => {
    const { ctl } = setup();
    const r = (await ctl.assert({
      checks: [{ type: "element", selector: ".x", state: "exists" }, { type: "value", selector: "input", equals: "a" }, { type: "count", selector: "li", min: 1 }, { type: "url", contains: "x" }],
    })) as { passed: boolean; results: { passed: boolean; error?: string }[] };
    expect(r.passed).toBe(false);
    expect(r.results.map((x) => x.passed)).toEqual([false, false, false, false]);
    expect(r.results[0].error).toBe(ERR_NATIVE_CHECK_UNSUPPORTED("element check with a CSS selector"));
    expect(r.results[3].error).toBe(ERR_NATIVE_CHECK_UNSUPPORTED("url check"));
    expect(r.results[3].error).toContain("Use a text check");
  });

  it("gives one result per check in order, with history checks passing", async () => {
    const { ctl } = setup();
    const checks = [{ type: "no_console_errors" }, { type: "text", text: "hello" }, { type: "no_failed_requests" }, { type: "url", contains: "x" }];
    const r = (await ctl.assert({ checks })) as { ok: boolean; results: { check: unknown; passed: boolean }[] };
    expect(r.results.map((x) => x.check)).toEqual(checks);
    expect(r.results.map((x) => x.passed)).toEqual([true, true, true, false]);
  });

  it("text absent with a truncated read cannot be proven", async () => {
    const { ctl } = setup({ read: () => ({ title: "Main", text: "abc", truncated: true }) });
    const r = (await ctl.assert({ checks: [{ type: "text", text: "zzz", absent: true }, { type: "text", text: "abc", absent: true }] })) as {
      results: { passed: boolean; error?: string; actual?: string }[];
    };
    expect(r.results[0]).toMatchObject({ passed: false, error: ERR_NATIVE_TEXT_ABSENT_CUT });
    expect(r.results[1]).toMatchObject({ passed: false, actual: "found" });
  });

  it("absent with an ambiguous match is not a pass, and exists is", async () => {
    const del = (index: number) => ({ index, tag: "button", label: "Delete", ops: ["CLICK"] });
    let phase = 0;
    const { ctl } = setup({ snapshot: () => ({ snapshotId: `s${phase}`, elements: phase === 0 ? [del(0)] : [del(5), del(6)], truncated: false, window: WIN }) });
    await ctl.snapshot();
    phase = 1;
    const r = (await ctl.assert({
      checks: [
        { type: "element", index: 0, state: "absent" },
        { type: "element", index: 0, state: "hidden" },
        { type: "element", index: 0, state: "exists" },
        { type: "element", index: 0, state: "enabled" },
        { type: "value", index: 0, contains: "x" },
      ],
    })) as { results: { passed: boolean; actual?: string; error?: string }[] };
    expect(r.results.map((x) => x.passed)).toEqual([false, false, true, false, false]);
    expect(r.results[3].error).toBe(ERR_NATIVE_CHECK_AMBIGUOUS(0, "button", "Delete"));
    expect(r.results[4].error).toBe(ERR_NATIVE_CHECK_AMBIGUOUS(0, "button", "Delete"));
  });

  it("not present in a truncated fresh snapshot is an error for every state", async () => {
    let phase = 0;
    const { ctl } = setup({ snapshot: () => ({ snapshotId: `s${phase}`, elements: phase === 0 ? EL : [], truncated: phase === 1, window: WIN }) });
    await ctl.snapshot();
    phase = 1;
    const r = (await ctl.assert({ checks: [{ type: "element", index: 0, state: "absent" }, { type: "element", index: 0, state: "exists" }, { type: "value", index: 2, equals: "" }] })) as {
      results: { passed: boolean; error?: string }[];
    };
    expect(r.results.map((x) => x.error)).toEqual([ERR_NATIVE_CHECK_CUT, ERR_NATIVE_CHECK_CUT, ERR_NATIVE_CHECK_CUT]);
    expect(r.results.every((x) => !x.passed)).toBe(true);
  });

  it("invalid checks are rejected like the web controller", async () => {
    const { ctl } = setup();
    expect(await ctl.assert({ checks: [{ type: "bogus" }] })).toMatchObject({ error: expect.stringMatching(/^assert: /) });
    expect(await ctl.assert({ checks: [] })).toMatchObject({ error: expect.stringMatching(/^assert: /) });
    expect(await ctl.assert("x")).toEqual({ error: 'assert requires an object with "checks".' });
    const eleven = Array.from({ length: 11 }, () => ({ type: "text", text: "a" }));
    expect(await ctl.assert({ checks: eleven })).toMatchObject({ error: expect.stringMatching(/^assert: /) });
  });

  it("an index check is dropped after the window changes", async () => {
    const W2 = { ...WIN, windowId: 12, title: "Other", focused: false, main: false };
    const { ctl } = setup({ windows: () => ({ windows: [WIN, W2] }) });
    await ctl.snapshot();
    expect(await ctl.assert({ checks: [{ type: "element", index: 0, state: "exists" }] })).toMatchObject({ results: [{ passed: true }] });
    await ctl.tabs({ action: "switch", tabId: 12 });
    const r = (await ctl.assert({ checks: [{ type: "element", index: 0, state: "exists" }] })) as { results: { passed: boolean; error?: string }[] };
    expect(r.results[0]).toMatchObject({ passed: false, error: ERR_NATIVE_CHECK_NO_INDEX(0) });
  });

  type R = { results: { passed: boolean; actual?: string; error?: string }[] };

  it("password value check: only equals empty, and only without a value", async () => {
    let hasValue = false;
    const { ctl } = setup({
      snapshot: () => ({
        snapshotId: "s",
        elements: [{ index: 0, tag: "securetextfield", label: "Password", ops: ["TYPE_TEXT"], isPassword: true, ...(hasValue ? { hasValue: true } : {}) }],
        truncated: false,
        window: WIN,
      }),
    });
    await ctl.snapshot();
    const empty = (await ctl.assert({ checks: [{ type: "value", index: 0, equals: "" }, { type: "value", index: 0, contains: "a" }] })) as R;
    expect(empty.results.map((x) => x.passed)).toEqual([true, false]);
    hasValue = true;
    const full = (await ctl.assert({ checks: [{ type: "value", index: 0, equals: "" }] })) as R;
    expect(full.results[0]).toMatchObject({ passed: false, actual: "value hidden (password field)" });
  });

  it("value on an element without a value, checked without a checked field", async () => {
    const { ctl } = setup();
    await ctl.snapshot();
    const r = (await ctl.assert({ checks: [{ type: "value", index: 0, equals: "x" }, { type: "element", index: 0, state: "unchecked" }, { type: "element", index: 0, state: "checked" }] })) as R;
    expect(r.results[0]).toMatchObject({ passed: false, error: ERR_NATIVE_CHECK_NO_VALUE });
    expect(r.results[1]).toMatchObject({ passed: false, error: ERR_NATIVE_CHECK_NO_CHECKED });
    expect(r.results[2]).toMatchObject({ passed: false, error: ERR_NATIVE_CHECK_NO_CHECKED });
  });

  it("an unlabeled element cannot be found again", async () => {
    const els = [{ index: 3, tag: "button", label: "button #3", ops: ["CLICK"] }];
    const { ctl } = setup({ snapshot: () => ({ snapshotId: "s", elements: els, truncated: false, window: WIN }) });
    await ctl.snapshot();
    const r = (await ctl.assert({ checks: [{ type: "element", index: 3, state: "exists" }, { type: "element", index: 3, state: "absent" }] })) as R;
    expect(r.results.map((x) => x.error)).toEqual([ERR_NATIVE_CHECK_NO_LABEL(3), ERR_NATIVE_CHECK_NO_LABEL(3)]);
  });

  it("an empty needle after squashing fails", async () => {
    const { ctl } = setup();
    const r = (await ctl.assert({ checks: [{ type: "text", text: " \n " }] })) as R;
    expect(r.results[0]).toMatchObject({ passed: false, error: ERR_NATIVE_CHECK_EMPTY_TEXT });
  });

  it("the window changing during assert gives the no-index error", async () => {
    const W2 = { ...WIN, windowId: 12, focused: false, main: false };
    let wins = [WIN, W2];
    const { ctl } = setup({
      windows: () => ({ windows: wins }),
      snapshot: (a) => {
        if (a.windowId === 11 && wins.length === 1) throw new HelperError("gone", "NO_WINDOW");
        return { snapshotId: "s" + String(a.windowId), elements: EL, truncated: false, window: a.windowId === 12 ? W2 : WIN };
      },
    });
    await ctl.snapshot();
    // The helper drops window 11: the big snapshot comes from window 12.
    wins = [W2];
    const r = (await ctl.assert({ checks: [{ type: "element", index: 0, state: "exists" }] })) as R;
    expect(r.results[0]).toMatchObject({ passed: false, error: ERR_NATIVE_CHECK_NO_INDEX(0) });
  });

  it("act and an annotated screenshot set the snapshot that index checks use", async () => {
    const a = setup();
    await a.ctl.act({ action: "wait", ms: 0 });
    expect(((await a.ctl.assert({ checks: [{ type: "element", index: 0, state: "exists" }] })) as R).results[0].passed).toBe(true);
    const b = setup();
    await b.ctl.screenshot({ annotate: true });
    expect(((await b.ctl.assert({ checks: [{ type: "element", index: 1, state: "exists" }] })) as R).results[0].passed).toBe(true);
  });
  it("a helper error becomes { error }", async () => {
    const { ctl } = setup({ read: () => { throw new HelperError("x", "NO_ACCESSIBILITY"); } });
    expect(await ctl.assert({ checks: [{ type: "text", text: "a" }] })).toEqual({ error: ERR_NO_ACCESSIBILITY });
  });
});

describe("target search order and read-back", () => {
  it("an exact match in the big snapshot beats a partial one in the small list", async () => {
    const small = [{ index: 0, tag: "button", label: "Run all", ops: ["CLICK"] }];
    const big = [...small, { index: 700, tag: "button", label: "Run", ops: ["CLICK"] }];
    const { ctl, of } = setup({
      snapshot: (a) => (a.maxElements === 1000 ? { snapshotId: "big", elements: big, truncated: false, window: WIN } : { snapshotId: "small", elements: small, truncated: true, window: WIN }),
    });
    expect(await ctl.act({ action: "click", target: "Run" })).toMatchObject({ matched: "Run" });
    expect(of("perform")[0].args).toMatchObject({ snapshotId: "big", index: 700 });
  });

  it("falls back to the partial match in the small list; exact in the small list takes no big snapshot", async () => {
    const small = [{ index: 0, tag: "button", label: "Run all", ops: ["CLICK"] }];
    const a = setup({ snapshot: (x) => ({ snapshotId: x.maxElements === 1000 ? "big" : "small", elements: small, truncated: x.maxElements !== 1000, window: WIN }) });
    await a.ctl.act({ action: "click", target: "Run" });
    expect(a.of("perform")[0].args).toMatchObject({ snapshotId: "small", index: 0 });
    const exact = [{ index: 0, tag: "button", label: "Run", ops: ["CLICK"] }];
    const b = setup({ snapshot: (x) => ({ snapshotId: "s", elements: exact, truncated: x.maxElements !== 1000, window: WIN }) });
    await b.ctl.act({ action: "click", target: "Run" });
    expect(b.of("snapshot").some((c) => c.args.maxElements === 1000)).toBe(false);
  });

  it("typeText read-back after a big-snapshot target uses the big cap", async () => {
    const field = { index: 600, tag: "textfield", label: "Search", ops: ["TYPE_TEXT"], value: "" };
    const { ctl, of } = setup({
      snapshot: (a) => ({ snapshotId: a.maxElements === 1000 ? "big" : "small", elements: a.maxElements === 1000 ? [...EL, field] : EL, truncated: a.maxElements !== 1000, window: WIN }),
    });
    await ctl.act({ action: "type", target: "Search", text: "hi" });
    // before (120), big search (1000), read-back (1000), after (120)
    expect(of("snapshot").map((c) => c.args.maxElements)).toEqual([120, 1000, 1000, 120]);
  });
});
