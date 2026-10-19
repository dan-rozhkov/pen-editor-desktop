import { describe, expect, it, vi, beforeEach } from "vitest";

// The canvas-link halves of the two preloads, driven through a mocked "electron".

const send = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();
const invoke = vi.fn(async () => "reply");
let exposed: Record<string, any> = {};

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => {
      exposed[name] = api;
    },
  },
  ipcRenderer: { send, on, removeListener, invoke },
}));

(globalThis as unknown as { document: unknown }).document = { documentElement: null };
(globalThis as unknown as { window: unknown }).window = { addEventListener: vi.fn() };

describe("editor tab preload: canvasHost", () => {
  beforeEach(() => {
    vi.resetModules();
    exposed = {};
    send.mockClear();
    on.mockClear();
    removeListener.mockClear();
  });

  it("exposes the agent layout markers on every editor tab", async () => {
    await import("../src/preload/tab");
    expect(exposed.penDesktop.agentLayout).toBe(true);
    expect(exposed.penDesktop.canvasHost).toBeDefined();
  });

  it("register/post/onMessage use the canvas channels; onMessage unsubscribes", async () => {
    await import("../src/preload/tab");
    const host = exposed.penDesktop.canvasHost;
    host.register();
    expect(send).toHaveBeenCalledWith("canvas:register");
    host.unregister();
    expect(send).toHaveBeenCalledWith("canvas:unregister");
    const env = { id: "a", sentAt: 1, msg: { kind: "x" } };
    host.post(env);
    expect(send).toHaveBeenCalledWith("canvas:to-panel", env);
    const cb = vi.fn();
    const off = host.onMessage(cb);
    const listener = on.mock.calls.find((c) => c[0] === "canvas:from-panel")![1];
    listener({}, env);
    expect(cb).toHaveBeenCalledWith(env);
    off();
    expect(removeListener).toHaveBeenCalledWith("canvas:from-panel", listener);
  });
});

describe("agent panel preload", () => {
  beforeEach(async () => {
    vi.resetModules();
    exposed = {};
    send.mockClear();
    on.mockClear();
    removeListener.mockClear();
    invoke.mockClear();
    await import("../src/preload/agentPanel");
  });

  it("exposes version 2 with canvas, browser and docs only", () => {
    expect(Object.keys(exposed.penAgentPanel).sort()).toEqual(["browser", "canvas", "docs", "version"]);
    expect(exposed.penAgentPanel.version).toBe(2);
  });

  it("canvas methods map to the channels", async () => {
    const c = exposed.penAgentPanel.canvas;
    await c.listTabs();
    expect(invoke).toHaveBeenCalledWith("canvas:list");
    await c.openTab({ activate: true });
    expect(invoke).toHaveBeenCalledWith("canvas:open", { activate: true });
    c.activateTab(7);
    expect(send).toHaveBeenCalledWith("canvas:activate", 7);
    const env = { id: "a", sentAt: 1, msg: { kind: "x" } };
    c.post(7, env);
    expect(send).toHaveBeenCalledWith("canvas:to-tab", { tabId: 7, env });
    const cb = vi.fn();
    const off = c.onMessage(cb);
    on.mock.calls.find((x) => x[0] === "canvas:from-tab")![1]({}, { tabId: 7, env });
    expect(cb).toHaveBeenCalledWith(7, env);
    off();
    expect(removeListener).toHaveBeenCalledWith("canvas:from-tab", expect.any(Function));
    const tcb = vi.fn();
    c.onTabsChanged(tcb);
    on.mock.calls.find((x) => x[0] === "canvas:tabs")![1]({}, [1]);
    expect(tcb).toHaveBeenCalledWith([1]);
  });

  it("docs.open invokes doc:open with the id and returns main's reply", async () => {
    invoke.mockResolvedValueOnce({ ok: true } as never);
    await expect(exposed.penAgentPanel.docs.open("abc_1")).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenLastCalledWith("doc:open", "abc_1");
  });

  it("browser goes through browser:command, shared, isolated and closeSession", async () => {
    const b = exposed.penAgentPanel.browser;
    await b.open({ url: "http://x" });
    expect(invoke).toHaveBeenLastCalledWith("browser:command", { command: "open", args: { url: "http://x" } });
    await b.isolated("s1").read({});
    expect(invoke).toHaveBeenLastCalledWith("browser:command", { command: "read", args: {}, session: "s1" });
    await b.closeSession("s1");
    expect(invoke).toHaveBeenLastCalledWith("browser:command", { command: "closeSession", session: "s1" });
  });
});
