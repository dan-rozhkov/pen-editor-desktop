import { describe, expect, it, vi } from "vitest";
import { createHistoryService, type HistoryContents, type HistoryPorts } from "../src/main/historyService";
import { createHistoryStore } from "../src/main/browser/historyStore";

type Handler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown;

function makeStore() {
  return createHistoryStore({
    filePath: "/h.json",
    fs: { read: async () => null, write: async () => {}, writeSync: () => {} },
    timers: { setTimeout: () => 1, clearTimeout: () => {} },
  });
}

function makeContents(id: number) {
  let loaded: (() => void) | undefined;
  let destroyed: (() => void) | undefined;
  let isDestroyed = false;
  const send = vi.fn();
  const c: HistoryContents = {
    id,
    isDestroyed: () => isDestroyed,
    sendTheme: (p) => send("history:theme", p),
    sendChanged: () => send("history:changed"),
    onLoaded: (cb) => (loaded = cb),
    onDestroyed: (cb) => (destroyed = cb),
  };
  return {
    c,
    send,
    load: () => loaded?.(),
    destroy: () => {
      isDestroyed = true;
      destroyed?.();
    },
  };
}

function setup(confirm = true) {
  const handlers = new Map<string, Handler>();
  const handle = vi.fn((channel: string, listener: Handler) => void handlers.set(channel, listener));
  const store = makeStore();
  const queue: Array<() => void> = [];
  const timers = {
    setTimeout: (cb: () => void) => {
      queue.push(cb);
      return cb;
    },
    clearTimeout: (h: unknown) => {
      const i = queue.indexOf(h as () => void);
      if (i >= 0) queue.splice(i, 1);
    },
  };
  const fireTimer = () => queue.shift()?.();
  const service = createHistoryService(store, { ipcMain: { handle, removeHandler: (c) => void handlers.delete(c) }, timers });
  const ports: HistoryPorts = { confirmClear: vi.fn(async () => confirm), openUrl: vi.fn() };
  const call = (channel: string, id: number, ...args: unknown[]) => handlers.get(channel)!({ sender: { id } }, ...args);
  return { service, store, handlers, handle, ports, call, fireTimer };
}

describe("history service", () => {
  it("registers each channel once, at creation, and dispose removes them", () => {
    const { service, handle, handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(["history:clear", "history:list", "history:open", "history:remove"]);
    expect(handle).toHaveBeenCalledTimes(4);
    service.dispose();
    expect(handlers.size).toBe(0);
  });

  it("answers only attached webContents, and stops after they are destroyed", async () => {
    const { service, store, ports, call } = setup();
    store.recordVisit("https://a.com/", 1);
    const a = makeContents(5);
    expect(call("history:list", 5, {})).toEqual({ ok: false });
    service.attach(a.c, "w1", () => "light", ports);
    expect(call("history:list", 5, {})).toMatchObject({ entries: [{ url: "https://a.com/" }] });
    expect(call("history:list", 6, {})).toEqual({ ok: false });
    expect(call("history:remove", 6, { url: "https://a.com/" })).toEqual({ ok: false });
    expect(await call("history:clear", 6)).toEqual({ ok: false });
    expect(call("history:open", 6, { url: "https://a.com/" })).toEqual({ ok: false });
    expect(store.list()).toHaveLength(1);
    a.destroy();
    expect(call("history:list", 5, {})).toEqual({ ok: false });
  });

  it("lists newest first, filtered by the query and capped at 1000", () => {
    const { service, store, ports, call } = setup();
    service.attach(makeContents(1).c, "w", () => "light", ports);
    store.recordVisit("https://old.com/", 1);
    store.recordVisit("https://new.com/", 9);
    store.setTitle("https://old.com/", "Needle");
    expect((call("history:list", 1, {}) as { entries: { url: string }[] }).entries.map((e) => e.url)).toEqual(["https://new.com/", "https://old.com/"]);
    expect((call("history:list", 1, { query: "needle" }) as { entries: unknown[] }).entries).toHaveLength(1);
    expect((call("history:list", 1, undefined) as { entries: unknown[] }).entries).toHaveLength(2);
    expect((call("history:list", 1, { query: 5 }) as { entries: unknown[] }).entries).toHaveLength(2);
    for (let i = 0; i < 1100; i++) store.recordVisit(`https://h${i}.com/`, 100 + i);
    expect((call("history:list", 1, {}) as { entries: unknown[] }).entries).toHaveLength(1000);
  });

  it("removes an entry and refuses a bad url", () => {
    const { service, store, ports, call } = setup();
    service.attach(makeContents(1).c, "w", () => "light", ports);
    store.recordVisit("https://a.com/", 1);
    expect(call("history:remove", 1, { url: "file:///x" })).toEqual({ ok: false });
    expect(call("history:remove", 1, "https://a.com/")).toEqual({ ok: false });
    expect(call("history:remove", 1, { url: "https://a.com/" })).toEqual({ ok: true });
    expect(store.list()).toEqual([]);
  });

  it("clears after the owning window confirms", async () => {
    const { service, store, ports, call } = setup(true);
    service.attach(makeContents(1).c, "w", () => "light", ports);
    store.recordVisit("https://a.com/", 1);
    expect(await call("history:clear", 1)).toEqual({ ok: true });
    expect(ports.confirmClear).toHaveBeenCalledTimes(1);
    expect(store.list()).toEqual([]);
  });

  it("keeps the history when the confirm is cancelled", async () => {
    const { service, store, ports, call } = setup(false);
    service.attach(makeContents(1).c, "w", () => "light", ports);
    store.recordVisit("https://a.com/", 1);
    expect(await call("history:clear", 1)).toEqual({ ok: false, cancelled: true });
    expect(store.list()).toHaveLength(1);
  });

  it("keeps the history when the confirm throws", async () => {
    const { service, store, ports, call } = setup();
    ports.confirmClear = async () => {
      throw new Error("window closed");
    };
    service.attach(makeContents(1).c, "w", () => "light", ports);
    store.recordVisit("https://a.com/", 1);
    expect(await call("history:clear", 1)).toEqual({ ok: false });
    expect(store.list()).toHaveLength(1);
  });

  it("opens only http(s) urls, through the sender's own port", () => {
    const { service, ports, call } = setup();
    const other: HistoryPorts = { confirmClear: async () => true, openUrl: vi.fn() };
    service.attach(makeContents(1).c, "w1", () => "light", ports);
    service.attach(makeContents(2).c, "w2", () => "light", other);
    expect(call("history:open", 1, { url: "https://a.com/p#x" })).toEqual({ ok: true });
    expect(ports.openUrl).toHaveBeenCalledWith("https://a.com/p");
    expect(other.openUrl).not.toHaveBeenCalled();
    expect(call("history:open", 1, { url: "javascript:alert(1)" })).toEqual({ ok: false });
    expect(call("history:open", 1, { url: "file:///etc/hosts" })).toEqual({ ok: false });
    expect(call("history:open", 1, {})).toEqual({ ok: false });
    expect(ports.openUrl).toHaveBeenCalledTimes(1);
  });

  it("sends the theme on each load and on a changed theme only", () => {
    const { service, ports } = setup();
    const a = makeContents(1);
    const b = makeContents(2);
    let theme: "light" | "dark" = "light";
    service.attach(a.c, "w1", () => theme, ports);
    service.attach(b.c, "w2", () => "dark", ports);
    a.load();
    a.load();
    expect(a.send.mock.calls).toEqual([["history:theme", { theme: "light" }], ["history:theme", { theme: "light" }]]);
    theme = "dark";
    service.setTheme("w1", "dark");
    service.setTheme("w1", "dark");
    expect(a.send).toHaveBeenCalledTimes(3);
    expect(a.send).toHaveBeenLastCalledWith("history:theme", { theme: "dark" });
    expect(b.send).not.toHaveBeenCalled(); // another window's tab
  });

  it("tells every attached tab when the store changes, but not a destroyed one", () => {
    const { service, store, ports, fireTimer } = setup();
    const a = makeContents(1);
    const b = makeContents(2);
    service.attach(a.c, "w1", () => "light", ports);
    service.attach(b.c, "w2", () => "light", ports);
    store.recordVisit("https://a.com/", 1);
    expect(a.send).toHaveBeenCalledWith("history:changed");
    expect(b.send).toHaveBeenCalledWith("history:changed");
    b.destroy();
    fireTimer(); // a's cool-down ends with nothing owed
    store.recordVisit("https://b.com/", 5000);
    expect(a.send).toHaveBeenCalledTimes(2);
    expect(b.send).toHaveBeenCalledTimes(1);
    service.dispose();
    store.recordVisit("https://c.com/", 9000);
    expect(a.send).toHaveBeenCalledTimes(2);
  });

  it("coalesces history:changed to one per window per tab, with a trailing send", () => {
    const { service, store, ports, fireTimer } = setup();
    const a = makeContents(1);
    service.attach(a.c, "w1", () => "light", ports);
    store.recordVisit("https://a.com/", 1);
    store.setTitle("https://a.com/", "A");
    store.recordVisit("https://b.com/", 5000);
    expect(a.send).toHaveBeenCalledTimes(1); // the first goes at once
    fireTimer(); // window over: one trailing send for the three changes
    expect(a.send).toHaveBeenCalledTimes(2);
    fireTimer(); // trailing send's own window, nothing owed
    store.recordVisit("https://c.com/", 9000);
    expect(a.send).toHaveBeenCalledTimes(3);
  });
});
