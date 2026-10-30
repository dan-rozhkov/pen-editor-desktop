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

  it("exposes version 2 with canvas, browser, docs, canvases, workflows, traces, auth and settings only", () => {
    expect(Object.keys(exposed.penAgentPanel).sort()).toEqual(["auth", "browser", "canvas", "canvases", "chats", "docs", "settings", "traces", "version", "workflows"]);
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

  it("docs.list / save / remove invoke their channels; docs has exactly onRemoved, open, list, save, remove", async () => {
    expect(Object.keys(exposed.penAgentPanel.docs).sort()).toEqual(["list", "onRemoved", "open", "remove", "save"]);
    await exposed.penAgentPanel.docs.list();
    expect(invoke).toHaveBeenLastCalledWith("docs:list");
    const doc = { id: "a", title: "t", markdown: "m", updatedAt: 1, rev: 1 };
    await exposed.penAgentPanel.docs.save(doc);
    expect(invoke).toHaveBeenLastCalledWith("docs:save", doc);
    await exposed.penAgentPanel.docs.remove("a");
    expect(invoke).toHaveBeenLastCalledWith("docs:delete", "a");
  });

  it("docs.onRemoved listens on docs:removed, passes only string ids, and unsubscribes", () => {
    const cb = vi.fn();
    const off = exposed.penAgentPanel.docs.onRemoved(cb);
    const listener = on.mock.calls.find((x) => x[0] === "docs:removed")![1];
    listener({}, ["a", 3, "b"]);
    expect(cb).toHaveBeenLastCalledWith(["a", "b"]);
    cb.mockClear();
    listener({}, "not-an-array");
    expect(cb).not.toHaveBeenCalled();
    off();
    expect(removeListener).toHaveBeenCalledWith("docs:removed", listener);
  });

  it("canvases has exactly list, over canvases:list", async () => {
    expect(Object.keys(exposed.penAgentPanel.canvases)).toEqual(["list"]);
    await exposed.penAgentPanel.canvases.list();
    expect(invoke).toHaveBeenLastCalledWith("canvases:list");
  });

  it("chats has exactly list, read, save, remove, over chats:*", async () => {
    expect(Object.keys(exposed.penAgentPanel.chats).sort()).toEqual(["list", "read", "remove", "save"]);
    await exposed.penAgentPanel.chats.list();
    expect(invoke).toHaveBeenLastCalledWith("chats:list");
    await exposed.penAgentPanel.chats.read("tab-1761400000000-3");
    expect(invoke).toHaveBeenLastCalledWith("chats:read", "tab-1761400000000-3");
    const chat = { id: "a", title: "t", titleIsAuto: true, model: "m", updatedAt: 1, rev: 1, messages: [] };
    await exposed.penAgentPanel.chats.save(chat);
    expect(invoke).toHaveBeenLastCalledWith("chats:save", chat);
    await exposed.penAgentPanel.chats.remove("a");
    expect(invoke).toHaveBeenLastCalledWith("chats:delete", "a");
  });

  it("docs.open invokes doc:open with the id and returns main's reply", async () => {
    invoke.mockResolvedValueOnce({ ok: true } as never);
    await expect(exposed.penAgentPanel.docs.open("abc_1")).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenLastCalledWith("doc:open", "abc_1");
  });

  it("workflows has exactly open, list, save, remove, onRemoved", async () => {
    expect(Object.keys(exposed.penAgentPanel.workflows).sort()).toEqual(["list", "onRemoved", "open", "remove", "save"]);
    invoke.mockResolvedValueOnce({ ok: true } as never);
    await expect(exposed.penAgentPanel.workflows.open("wf_abc123def456")).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenLastCalledWith("workflow:open", "wf_abc123def456");
    await exposed.penAgentPanel.workflows.list();
    expect(invoke).toHaveBeenLastCalledWith("workflows:list");
    const wf = { id: "wf_a", title: "t", steps: [], updatedAt: 1, rev: 1 };
    await exposed.penAgentPanel.workflows.save(wf);
    expect(invoke).toHaveBeenLastCalledWith("workflows:save", wf);
    await exposed.penAgentPanel.workflows.remove("wf_a");
    expect(invoke).toHaveBeenLastCalledWith("workflows:delete", "wf_a");
  });

  it("workflows.onRemoved listens on workflows:removed, passes only string ids, and unsubscribes", () => {
    const cb = vi.fn();
    const off = exposed.penAgentPanel.workflows.onRemoved(cb);
    const listener = on.mock.calls.find((x) => x[0] === "workflows:removed")![1];
    listener({}, ["wf_a", 3, "wf_b"]);
    expect(cb).toHaveBeenCalledWith(["wf_a", "wf_b"]);
    listener({}, "nope");
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    expect(removeListener).toHaveBeenCalledWith("workflows:removed", listener);
  });

  it("settings.open invokes settings:open with the optional section and returns main's reply", async () => {
    expect(Object.keys(exposed.penAgentPanel.settings)).toEqual(["open"]);
    invoke.mockResolvedValueOnce({ ok: true } as never);
    await expect(exposed.penAgentPanel.settings.open("integrations")).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenLastCalledWith("settings:open", "integrations");
    await exposed.penAgentPanel.settings.open();
    expect(invoke).toHaveBeenLastCalledWith("settings:open", undefined);
  });

  it("traces.save and traces.open invoke their channels and return main's reply", async () => {
    const payload = { manifest: { id: "t1" }, assets: [{ path: "frames/0.jpg", dataUrl: "data:image/jpeg;base64,AA==" }] };
    invoke.mockResolvedValueOnce({ id: "t1" } as never);
    await expect(exposed.penAgentPanel.traces.save(payload)).resolves.toEqual({ id: "t1" });
    expect(invoke).toHaveBeenLastCalledWith("traces:save", payload);
    invoke.mockResolvedValueOnce({ ok: true } as never);
    await expect(exposed.penAgentPanel.traces.open("t1")).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenLastCalledWith("traces:open", "t1");
    expect(Object.keys(exposed.penAgentPanel.traces).sort()).toEqual(["listTabs", "open", "read", "save"]);
    await expect(exposed.penAgentPanel.traces.listTabs()).resolves.toBeDefined();
    expect(invoke).toHaveBeenLastCalledWith("traces:list-tabs");
    await exposed.penAgentPanel.traces.read("t1");
    expect(invoke).toHaveBeenLastCalledWith("traces:read", "t1");
    await exposed.penAgentPanel.traces.read("t1", { frames: false });
    expect(invoke).toHaveBeenLastCalledWith("traces:read", "t1", { frames: false });
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
