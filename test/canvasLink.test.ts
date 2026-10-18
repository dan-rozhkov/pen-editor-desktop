import { describe, expect, it, vi } from "vitest";
import { CanvasLinkRouter, OPEN_TIMEOUT_MS, ERR_OPEN_TIMEOUT, ERR_OPEN_CLOSED, type CanvasTabInfo, type LinkEnvelope } from "../src/main/canvasLink";

const PANEL = 1;
const A = 10;
const B = 11;

function setup(editorTabs: number[] = [A, B]) {
  const fromTab: { tabId: number; env: LinkEnvelope }[] = [];
  const tabsPushes: CanvasTabInfo[][] = [];
  const toTab: { id: number; env: LinkEnvelope }[] = [];
  const activated: number[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const live = new Set(editorTabs);
  let nextOpened = 100;
  const router = new CanvasLinkRouter({
    isEditorTab: (id) => live.has(id),
    isPanel: (id) => id === PANEL,
    sendFromTab: (m) => fromTab.push(m),
    sendTabs: (t) => tabsPushes.push(t),
    sendFromPanel: (id, env) => toTab.push({ id, env }),
    openEditorTab: () => {
      const id = nextOpened++;
      live.add(id);
      return id;
    },
    activateTab: (id) => activated.push(id),
    now: () => 1234,
    timers: {
      set: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clear: (h) => {
        (h as { cleared: boolean }).cleared = true;
      },
    },
  });
  const env = (id: string, kind = "ping"): LinkEnvelope => ({ id, sentAt: 1, msg: { kind } });
  const syncAll = (active: number | null, list = [...live]) => router.syncTabs(list.map((id) => ({ webContentsId: id, title: `T${id}` })), active);
  return { router, fromTab, tabsPushes, toTab, activated, timers, live, env, syncAll };
}

describe("CanvasLinkRouter routing", () => {
  it("panel -> tab reaches a registered tab unchanged", () => {
    const s = setup();
    s.router.register(A);
    const e = s.env("m1");
    s.router.toTab(PANEL, { tabId: A, env: e });
    expect(s.toTab).toEqual([{ id: A, env: e }]);
  });

  it("panel -> unknown or unregistered tab answers an error to the panel", () => {
    const s = setup();
    s.router.toTab(PANEL, { tabId: A, env: s.env("m1") }); // A exists but never registered
    s.router.toTab(PANEL, { tabId: 999, env: s.env("m2") });
    expect(s.toTab).toEqual([]);
    expect(s.fromTab.map((m) => [m.tabId, m.env.msg.kind, m.env.msg.refId])).toEqual([
      [A, "error", "m1"],
      [999, "error", "m2"],
    ]);
    expect(typeof s.fromTab[0].env.msg.error).toBe("string");
    expect(s.fromTab[0].env.sentAt).toBe(1234);
  });

  it("tab -> panel adds the sender tabId", () => {
    const s = setup();
    s.router.register(B);
    const e = s.env("r1", "result");
    s.router.toPanel(B, e);
    expect(s.fromTab).toEqual([{ tabId: B, env: e }]);
  });

  it("tab -> panel from an unregistered tab is dropped", () => {
    const s = setup();
    s.router.toPanel(A, s.env("x"));
    expect(s.fromTab).toEqual([]);
  });

  it("main-only kinds from renderers are dropped in both directions", () => {
    const s = setup();
    s.router.register(A);
    for (const kind of ["error", "tab-gone"]) {
      s.router.toPanel(A, s.env("x", kind));
      s.router.toTab(PANEL, { tabId: A, env: s.env("y", kind) });
    }
    expect(s.fromTab).toEqual([]);
    expect(s.toTab).toEqual([]);
  });

  it("malformed envelopes and payloads are dropped", () => {
    const s = setup();
    s.router.register(A);
    for (const bad of [null, 1, "x", {}, { id: 1, sentAt: 1, msg: { kind: "a" } }, { id: "a", sentAt: "1", msg: { kind: "a" } }, { id: "a", sentAt: 1, msg: null }, { id: "a", sentAt: 1, msg: { kind: 5 } }, { id: "a", sentAt: NaN, msg: { kind: "a" } }]) {
      s.router.toPanel(A, bad);
      s.router.toTab(PANEL, { tabId: A, env: bad });
    }
    s.router.toTab(PANEL, null);
    s.router.toTab(PANEL, { tabId: "10", env: s.env("z") });
    expect(s.fromTab).toEqual([]);
    expect(s.toTab).toEqual([]);
  });

  it("keeps the order of 500 messages in both directions", () => {
    const s = setup();
    s.router.register(A);
    for (let i = 0; i < 500; i++) {
      s.router.toTab(PANEL, { tabId: A, env: s.env(`p${i}`) });
      s.router.toPanel(A, s.env(`t${i}`));
    }
    expect(s.toTab.map((m) => m.env.id)).toEqual(Array.from({ length: 500 }, (_, i) => `p${i}`));
    expect(s.fromTab.map((m) => m.env.id)).toEqual(Array.from({ length: 500 }, (_, i) => `t${i}`));
  });

  it("sender checks: only the panel may use panel channels, only registered editor tabs the tab channels", () => {
    const s = setup();
    s.router.register(A);
    const stranger = 77;
    s.router.register(stranger); // not an editor tab
    s.router.toTab(stranger, { tabId: A, env: s.env("a") });
    s.router.toTab(A, { tabId: A, env: s.env("b") }); // a tab pretending to be the panel
    s.router.toPanel(stranger, s.env("c"));
    s.router.activate(A, A);
    expect(s.router.list(A)).toEqual([]);
    expect(s.router.list(stranger)).toEqual([]);
    expect(s.toTab).toEqual([]);
    expect(s.fromTab).toEqual([]);
    expect(s.activated).toEqual([]);
    expect(s.router.listTabs().map((t) => t.tabId)).toEqual([A]);
    return expect(s.router.open(A, {})).rejects.toThrow("Not allowed.");
  });
});

describe("CanvasLinkRouter registry", () => {
  it("registrationId increments on every register, also after a gone", () => {
    const s = setup();
    s.router.register(A);
    expect(s.router.listTabs()[0].registrationId).toBe(1);
    s.router.register(A); // double register
    expect(s.router.listTabs()[0].registrationId).toBe(2);
    s.router.tabGone(A); // reload
    s.router.register(A);
    expect(s.router.listTabs()[0].registrationId).toBe(3);
  });

  it("a double register tells the panel the old registration is gone", () => {
    const s = setup();
    s.router.register(A);
    s.router.register(A);
    expect(s.fromTab.map((m) => m.env.msg)).toEqual([{ kind: "tab-gone", registrationId: 1 }]);
  });

  it("tab-gone on reload/crash (registrationId) removes the tab and pushes the list", () => {
    const s = setup();
    s.router.register(A);
    s.tabsPushes.length = 0;
    s.router.tabGone(A);
    expect(s.fromTab).toEqual([{ tabId: A, env: { id: "main-1", sentAt: 1234, msg: { kind: "tab-gone", registrationId: 1 } } }]);
    expect(s.router.listTabs()).toEqual([]);
    expect(s.tabsPushes).toEqual([[]]);
    // A message to the gone tab is now an error.
    s.router.toTab(PANEL, { tabId: A, env: s.env("late") });
    expect(s.fromTab[1].env.msg.kind).toBe("error");
  });

  it("tab-gone on destroy resets the registration counter; an unregistered tab sends nothing", () => {
    const s = setup();
    s.router.tabGone(B); // never registered: silent
    expect(s.fromTab).toEqual([]);
    s.router.register(A);
    s.router.tabGone(A, true);
    s.router.register(A);
    expect(s.router.listTabs()[0].registrationId).toBe(1);
  });

  it("orders the list by activation, most recent first, and pushes on change only", () => {
    const s = setup();
    s.router.register(A);
    s.router.register(B);
    s.syncAll(A);
    s.syncAll(B);
    expect(s.router.listTabs().map((t) => [t.tabId, t.active])).toEqual([[B, true], [A, false]]);
    const n = s.tabsPushes.length;
    s.syncAll(B); // nothing changed
    expect(s.tabsPushes.length).toBe(n);
    s.syncAll(null); // a browser tab is active: order kept, nobody active
    expect(s.router.listTabs().map((t) => [t.tabId, t.active])).toEqual([[B, false], [A, false]]);
    s.syncAll(A);
    expect(s.router.listTabs().map((t) => t.tabId)).toEqual([A, B]);
  });

  it("a title change pushes the list", () => {
    const s = setup();
    s.router.register(A);
    s.syncAll(A);
    s.tabsPushes.length = 0;
    s.router.syncTabs([{ webContentsId: A, title: "Renamed" }], A);
    expect(s.tabsPushes.at(-1)?.[0].title).toBe("Renamed");
  });

  it("list() returns the registered tabs for the panel", () => {
    const s = setup();
    s.router.register(A);
    expect(s.router.list(PANEL).map((t) => t.tabId)).toEqual([A]);
  });

  it("activate only works for a registered tab", () => {
    const s = setup();
    s.router.register(A);
    s.router.activate(PANEL, B);
    s.router.activate(PANEL, "x");
    s.router.activate(PANEL, A);
    expect(s.activated).toEqual([A]);
  });
});

describe("CanvasLinkRouter open", () => {
  it("resolves with the new tab once THAT tab registers", async () => {
    const s = setup();
    const p = s.router.open(PANEL, { activate: true });
    s.router.register(A); // some other tab registering does not resolve it
    let done = false;
    void p.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    s.router.register(100);
    await expect(p).resolves.toEqual({ tabId: 100, registrationId: 1 });
    expect(s.timers[0].cleared).toBe(true);
  });

  it("a re-registering tab resolves with its NEW registrationId", async () => {
    const s = setup();
    const p = s.router.open(PANEL, {});
    s.router.register(100);
    await expect(p).resolves.toEqual({ tabId: 100, registrationId: 1 });
    s.router.tabGone(100);
    const p2 = s.router.open(PANEL, {});
    void p2.catch(() => {});
  });

  it("passes activate only when it is exactly true", () => {
    const flags: boolean[] = [];
    const r = new CanvasLinkRouter({
      isEditorTab: () => true,
      isPanel: () => true,
      sendFromTab: () => {},
      sendTabs: () => {},
      sendFromPanel: () => {},
      openEditorTab: (a) => (flags.push(a), 5),
      activateTab: () => {},
      now: () => 0,
      timers: { set: () => 0, clear: () => {} },
    });
    void r.open(1, undefined);
    void r.open(1, { activate: "yes" });
    void r.open(1, { activate: true });
    expect(flags).toEqual([false, false, true]);
  });

  it("rejects after 20 s", async () => {
    const s = setup();
    const p = s.router.open(PANEL, {});
    expect(s.timers[0].ms).toBe(OPEN_TIMEOUT_MS);
    expect(OPEN_TIMEOUT_MS).toBe(20_000);
    s.timers[0].fn();
    await expect(p).rejects.toThrow(ERR_OPEN_TIMEOUT);
    // A late register after the timeout resolves nothing and does not throw.
    s.router.register(100);
  });

  it("rejects when the new tab is destroyed before it registers, not when it only navigates", async () => {
    const s = setup();
    const p = s.router.open(PANEL, {});
    s.router.tabGone(100); // first load / reload: still waiting
    s.router.tabGone(100, true);
    await expect(p).rejects.toThrow(ERR_OPEN_CLOSED);
  });

  it("dispose rejects pending opens", async () => {
    const s = setup();
    const p = s.router.open(PANEL, {});
    s.router.dispose();
    await expect(p).rejects.toThrow(ERR_OPEN_CLOSED);
  });

  it("uses real timers by default", async () => {
    vi.useFakeTimers();
    try {
      const r = new CanvasLinkRouter({
        isEditorTab: () => true,
        isPanel: () => true,
        sendFromTab: () => {},
        sendTabs: () => {},
        sendFromPanel: () => {},
        openEditorTab: () => 5,
        activateTab: () => {},
        now: () => 0,
      });
      const p = r.open(1, {});
      const assertion = expect(p).rejects.toThrow(ERR_OPEN_TIMEOUT);
      await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CanvasLinkRouter unregister + sync", () => {
  it("unregister: tab-gone to the panel, tab leaves the list; only a registered editor tab", () => {
    const s = setup();
    s.router.register(A);
    s.fromTab.length = 0;
    s.router.unregister(PANEL); // not an editor tab
    s.router.unregister(B); // never registered
    expect(s.fromTab).toEqual([]);
    s.router.unregister(A);
    expect(s.fromTab.map((m) => [m.tabId, m.env.msg.kind, m.env.msg.registrationId])).toEqual([[A, "tab-gone", 1]]);
    expect(s.router.listTabs()).toEqual([]);
    // The tab can register again and gets a new registrationId.
    s.router.register(A);
    expect(s.router.listTabs()[0].registrationId).toBe(2);
  });

  it("syncTabs with unchanged tabs, titles and activation does nothing", () => {
    const s = setup();
    s.router.register(A);
    s.syncAll(A);
    const pushes = s.tabsPushes.length;
    const listSpy = vi.spyOn(s.router, "listTabs");
    s.syncAll(A);
    s.syncAll(A);
    expect(listSpy).not.toHaveBeenCalled();
    expect(s.tabsPushes.length).toBe(pushes);
    s.router.syncTabs([{ webContentsId: A, title: "New" }, { webContentsId: B, title: `T${B}` }], A);
    expect(s.tabsPushes[s.tabsPushes.length - 1][0].title).toBe("New");
  });
});

describe("CanvasLinkRouter closing tabs, renderer death, panel reload", () => {
  it("syncTabs drops a registered id that is no longer an editor tab", () => {
    const s = setup();
    s.router.register(A);
    s.router.register(B);
    s.fromTab.length = 0;
    s.router.syncTabs([{ webContentsId: A, title: "A" }], A);
    expect(s.router.listTabs().map((t) => t.tabId)).toEqual([A]);
    expect(s.fromTab.map((m) => [m.tabId, m.env.msg.kind])).toEqual([[B, "tab-gone"]]);
    expect(s.tabsPushes[s.tabsPushes.length - 1].map((t) => t.title)).toEqual(["A"]);
  });

  it("renderer death rejects a pending open; a plain tabGone (first navigation) does not", async () => {
    const s = setup();
    const p1 = s.router.open(PANEL, {});
    s.router.tabGone(100);
    let settled = false;
    p1.catch(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    s.router.rendererGone(100);
    await expect(p1).rejects.toThrow(ERR_OPEN_CLOSED);
  });

  it("rendererGone on a registered tab sends tab-gone and keeps its counters", () => {
    const s = setup();
    s.router.register(A);
    s.fromTab.length = 0;
    s.router.rendererGone(A);
    expect(s.fromTab.map((m) => m.env.msg.kind)).toEqual(["tab-gone"]);
    s.router.register(A);
    expect(s.router.listTabs()[0].registrationId).toBe(2);
  });

  it("panelGone tells every registered tab and the next list/push is not deduped", () => {
    const s = setup();
    s.router.register(A);
    s.router.register(B);
    s.router.register(99 as number); // not an editor tab: ignored
    s.toTab.length = 0;
    s.router.panelGone();
    expect(s.toTab.map((m) => [m.id, m.env.msg.kind]).sort()).toEqual([
      [A, "panel-gone"],
      [B, "panel-gone"],
    ]);
    const before = s.tabsPushes.length;
    s.router.repush();
    expect(s.tabsPushes.length).toBe(before + 1);
    s.router.repush();
    expect(s.tabsPushes.length).toBe(before + 2);
  });

  it("after panelGone, an unchanged tab list is pushed again on the next change signal", () => {
    const s = setup();
    s.router.register(A);
    s.syncAll(A);
    const before = s.tabsPushes.length;
    s.router.panelGone();
    s.router.tabGone(B); // B never registered: no push
    s.router.register(B);
    s.router.tabGone(B);
    expect(s.tabsPushes.length).toBeGreaterThan(before);
  });

  it("a renderer cannot forge panel-gone", () => {
    const s = setup();
    s.router.register(A);
    s.router.toPanel(A, s.env("x", "panel-gone"));
    s.router.toTab(PANEL, { tabId: A, env: s.env("y", "panel-gone") });
    expect(s.toTab).toEqual([]);
    expect(s.fromTab.filter((m) => m.env.msg.kind === "panel-gone")).toEqual([]);
  });
});
