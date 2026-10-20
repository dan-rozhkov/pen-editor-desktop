import { describe, expect, it, vi, beforeEach } from "vitest";

// Finding 6: registerMcpBridge (src/preload/tab.ts) is the API boundary for
// the desktop MCP bridge, and must not depend on its caller (the page)
// already guarding against a double call — React StrictMode double-invoking
// an effect in dev, or HMR, can land two registrations from a
// well-intentioned caller. This drives the exported `penDesktop` API exactly
// the way desktopMcpBridge.ts does, through a mocked "electron" module, and
// never imports Electron for real.

const sendMock = vi.fn();
const onMock = vi.fn();
const removeListenerMock = vi.fn();
const invokeMock = vi.fn();

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: unknown) => {
      exposedApi = api;
    },
  },
  ipcRenderer: {
    send: sendMock,
    on: onMock,
    removeListener: removeListenerMock,
    invoke: invokeMock,
  },
}));

// tab.ts's module-scope theme observer touches `document`/`window` at import
// time — stub the minimal shape it needs (no DOM environment in this suite)
// so importing the module under test doesn't throw. `documentElement: null`
// takes the "defer until DOMContentLoaded" branch, which never touches
// anything else on these stubs.
(globalThis as unknown as { document: unknown }).document = { documentElement: null };
(globalThis as unknown as { window: unknown }).window = { addEventListener: vi.fn() };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let exposedApi: any;

interface McpBridgeHandler {
  protocol: number;
  tools: string[];
  onCall(name: string, args: Record<string, unknown>): Promise<string>;
}

describe("preload/tab.ts registerMcpBridge — single-registration guard at the API boundary", () => {
  beforeEach(async () => {
    vi.resetModules();
    sendMock.mockClear();
    onMock.mockClear();
    removeListenerMock.mockClear();
    exposedApi = undefined;
    await import("../src/preload/tab");
  });

  function makeHandler(onCall = vi.fn(async () => "{}")): McpBridgeHandler {
    return { protocol: 1, tools: ["get_editor_state"], onCall };
  }

  it("a second registerMcpBridge call auto-tears-down the first, leaving exactly one live 'mcp:call' listener", () => {
    exposedApi.registerMcpBridge(makeHandler());
    exposedApi.registerMcpBridge(makeHandler());

    expect(onMock).toHaveBeenCalledTimes(2);
    expect(onMock.mock.calls[0][0]).toBe("mcp:call");
    expect(onMock.mock.calls[1][0]).toBe("mcp:call");

    // The first listener was removed before the second was ever installed —
    // the invariant that stops two listeners from both firing per mcp:call.
    const firstListener = onMock.mock.calls[0][1];
    expect(removeListenerMock).toHaveBeenCalledTimes(1);
    expect(removeListenerMock).toHaveBeenCalledWith("mcp:call", firstListener);

    // Ordering: register #1, then its auto-teardown (mcp:register null),
    // then register #2 — never two live registrations at once.
    const registerSends = sendMock.mock.calls.filter((c) => c[0] === "mcp:register");
    expect(registerSends.map((c) => c[1])).toEqual([
      { protocol: 1, tools: ["get_editor_state"] },
      null,
      { protocol: 1, tools: ["get_editor_state"] },
    ]);
  });

  it("only the second registration's onCall fires for a call delivered after both would otherwise be live", async () => {
    const onCall1 = vi.fn(async () => "{}");
    const onCall2 = vi.fn(async () => "{}");
    exposedApi.registerMcpBridge(makeHandler(onCall1));
    exposedApi.registerMcpBridge(makeHandler(onCall2));

    // Only the second call's listener is still registered with ipcRenderer
    // in production; drive it directly the way a real "mcp:call" event would.
    const secondListener = onMock.mock.calls[1][1];
    secondListener({}, { callId: "call-1", tool: "get_editor_state", args: {} });
    await Promise.resolve();
    await Promise.resolve();

    expect(onCall2).toHaveBeenCalledTimes(1);
    expect(onCall1).not.toHaveBeenCalled();
  });

  it("calling the first registration's own teardown after it was auto-torn-down is a no-op (does not touch the second registration)", () => {
    const teardown1 = exposedApi.registerMcpBridge(makeHandler()) as () => void;
    exposedApi.registerMcpBridge(makeHandler());

    sendMock.mockClear();
    removeListenerMock.mockClear();

    teardown1(); // already torn down automatically when #2 registered

    expect(sendMock).not.toHaveBeenCalled();
    expect(removeListenerMock).not.toHaveBeenCalled();
  });

  it("a single registration's own teardown removes its listener and unregisters the tab exactly once", () => {
    const teardown = exposedApi.registerMcpBridge(makeHandler()) as () => void;
    sendMock.mockClear();

    teardown();
    teardown(); // idempotent

    expect(removeListenerMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith("mcp:register", null);
  });
});

describe("preload/tab.ts browser checkpoint journal commands", () => {
  beforeEach(async () => {
    vi.resetModules();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue("ok");
    exposedApi = undefined;
    await import("../src/preload/tab");
  });

  it("startJournal sends the opts as args", async () => {
    await exposedApi.browser.startJournal({ origins: ["https://a.test"] });
    expect(invokeMock).toHaveBeenCalledWith("browser:command", {
      command: "startJournal",
      args: { origins: ["https://a.test"] },
    });
  });

  it("stopJournal sends the token", async () => {
    await exposedApi.browser.stopJournal("tok");
    expect(invokeMock).toHaveBeenCalledWith("browser:command", { command: "stopJournal", args: { token: "tok" } });
  });

  it("captureCheckpoint sends the token and resolves to the main result", async () => {
    invokeMock.mockResolvedValue({ ok: true });
    await expect(exposedApi.browser.captureCheckpoint("tok")).resolves.toEqual({ ok: true });
    expect(invokeMock).toHaveBeenCalledWith("browser:command", { command: "captureCheckpoint", args: { token: "tok" } });
  });
});

describe("preload/tab.ts isolated browser sessions", () => {
  beforeEach(async () => {
    vi.resetModules();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue("ok");
    exposedApi = undefined;
    await import("../src/preload/tab");
  });

  it("the shared browser sends no session key", async () => {
    await exposedApi.browser.open({ url: "https://a.test" });
    expect(invokeMock.mock.calls[0][1]).toEqual({ command: "open", args: { url: "https://a.test" } });
    expect("session" in invokeMock.mock.calls[0][1]).toBe(false);
  });

  it("isolated(id) has every method of browser and tags each call with the session", async () => {
    const iso = exposedApi.browser.isolated("run-1");
    const methods = [
      "open", "act", "findImages", "snapshot", "perform", "assert", "read", "screenshot", "tabs", "capture",
      "applyFixture", "releaseFixture", "clearActEmulation", "fillLogin", "startJournal", "stopJournal", "captureCheckpoint",
    ];
    for (const m of methods) expect(typeof iso[m], m).toBe("function");
    for (const m of methods) {
      invokeMock.mockClear();
      await iso[m]({});
      expect(invokeMock.mock.calls[0][0]).toBe("browser:command");
      expect(invokeMock.mock.calls[0][1]).toMatchObject({ command: m, session: "run-1" });
    }
  });

  it("isolated(undefined) still carries a session key, so main rejects it instead of using the shared browser", async () => {
    await exposedApi.browser.isolated(undefined).snapshot();
    expect("session" in invokeMock.mock.calls[0][1]).toBe(true);
  });

  it("launchApp sends open with only { app }, shared or isolated; releaseApp is exposed beside it", async () => {
    await exposedApi.browser.launchApp({ app: "/Applications/Orca.app", url: "https://x.test" });
    expect(invokeMock.mock.calls[0][1]).toEqual({ command: "open", args: { app: "/Applications/Orca.app" } });
    invokeMock.mockClear();
    await exposedApi.browser.isolated("run-1").launchApp({ app: "/Applications/Orca.app" });
    expect(invokeMock.mock.calls[0][1]).toEqual({ command: "open", args: { app: "/Applications/Orca.app" }, session: "run-1" });
    expect(typeof exposedApi.browser.releaseApp).toBe("function");
    expect(typeof exposedApi.browser.isolated("run-1").releaseApp).toBe("function");
  });

  it("closeSession sends the closeSession command", async () => {
    await exposedApi.browser.closeSession("run-1");
    expect(invokeMock).toHaveBeenCalledWith("browser:command", { command: "closeSession", session: "run-1" });
  });
});

describe("preload/tab.ts traces bridge", () => {
  beforeEach(async () => {
    vi.resetModules();
    invokeMock.mockClear();
    exposedApi = undefined;
    await import("../src/preload/tab");
  });

  it("exposes only save and read, over traces:save / traces:read", async () => {
    expect(Object.keys(exposedApi.traces).sort()).toEqual(["read", "save"]);
    const payload = { manifest: { id: "t1" }, assets: [] };
    invokeMock.mockResolvedValueOnce({ id: "t1" });
    await expect(exposedApi.traces.save(payload)).resolves.toEqual({ id: "t1" });
    expect(invokeMock).toHaveBeenLastCalledWith("traces:save", payload);
    invokeMock.mockResolvedValueOnce({ error: "trace not found" });
    await expect(exposedApi.traces.read("t1")).resolves.toEqual({ error: "trace not found" });
    expect(invokeMock).toHaveBeenLastCalledWith("traces:read", "t1");
  });
});

describe("preload/tab.ts docs bridge", () => {
  async function load(pathname: string) {
    vi.resetModules();
    invokeMock.mockClear();
    exposedApi = undefined;
    (globalThis as unknown as { location: unknown }).location = { pathname };
    await import("../src/preload/tab");
  }

  it("on every page exposes list, save and remove over docs:list / docs:save / docs:delete", async () => {
    await load("/app");
    expect(Object.keys(exposedApi.docs).sort()).toEqual(["list", "remove", "save"]);
    invokeMock.mockResolvedValueOnce({ docs: [] });
    await expect(exposedApi.docs.list()).resolves.toEqual({ docs: [] });
    expect(invokeMock).toHaveBeenLastCalledWith("docs:list");
    const doc = { id: "a", title: "t", markdown: "m", updatedAt: 1, rev: 1 };
    invokeMock.mockResolvedValueOnce({ ok: true, rev: 1 });
    await expect(exposedApi.docs.save(doc)).resolves.toEqual({ ok: true, rev: 1 });
    expect(invokeMock).toHaveBeenLastCalledWith("docs:save", doc);
    invokeMock.mockResolvedValueOnce({ ok: true });
    await expect(exposedApi.docs.remove("a")).resolves.toEqual({ ok: true });
    expect(invokeMock).toHaveBeenLastCalledWith("docs:delete", "a");
  });

  it("on the trace viewer page adds open, over doc:open", async () => {
    await load("/trace/abc");
    expect(Object.keys(exposedApi.docs).sort()).toEqual(["list", "open", "remove", "save"]);
    invokeMock.mockResolvedValueOnce({ ok: true });
    await expect(exposedApi.docs.open("abc_1")).resolves.toEqual({ ok: true });
    expect(invokeMock).toHaveBeenLastCalledWith("doc:open", "abc_1");
  });

  it("has no open on other pages (main refuses them anyway)", async () => {
    await load("/app");
    expect(exposedApi.docs.open).toBeUndefined();
  });
});

describe("desktop sign-in bridge (auth) in both preloads", () => {
  const cases: [string, string, string][] = [
    ["editor tab preload", "../src/preload/tab", "penDesktop"],
    ["agent panel preload", "../src/preload/agentPanel", "penAgentPanel"],
  ];
  for (const [label, file] of cases) {
    describe(label, () => {
      beforeEach(async () => {
        vi.resetModules();
        sendMock.mockClear();
        onMock.mockClear();
        removeListenerMock.mockClear();
        exposedApi = undefined;
        await import(/* @vite-ignore */ file);
      });

      it("signIn() sends auth:sign-in with no payload", () => {
        exposedApi.auth.signIn();
        expect(sendMock).toHaveBeenCalledWith("auth:sign-in");
        expect(sendMock.mock.calls.at(-1)).toHaveLength(1);
      });

      it("onToken(cb) delivers { token, verifier } from auth:token and the returned function unsubscribes", () => {
        const cb = vi.fn();
        const off = exposedApi.auth.onToken(cb) as () => void;
        expect(onMock).toHaveBeenCalledWith("auth:token", expect.any(Function));
        const listener = onMock.mock.calls.find((c) => c[0] === "auth:token")![1];
        listener({}, { token: "t", verifier: "v" });
        expect(cb).toHaveBeenCalledWith({ token: "t", verifier: "v" });
        off();
        expect(removeListenerMock).toHaveBeenCalledWith("auth:token", listener);
      });

      it("onToken sends auth:listen on subscribe and auth:unlisten only when the last subscriber leaves", () => {
        const offA = exposedApi.auth.onToken(vi.fn()) as () => void;
        const offB = exposedApi.auth.onToken(vi.fn()) as () => void;
        expect(sendMock.mock.calls.filter((c) => c[0] === "auth:listen")).toHaveLength(2);
        offA();
        offA(); // double unsubscribe is a no-op
        expect(sendMock.mock.calls.some((c) => c[0] === "auth:unlisten")).toBe(false);
        offB();
        expect(sendMock.mock.calls.filter((c) => c[0] === "auth:unlisten")).toHaveLength(1);
      });
    });
  }
});
