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
